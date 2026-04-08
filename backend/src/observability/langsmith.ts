import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { Context } from 'hono'
import { RunTree } from 'langsmith'

type MaybeRunTree = RunTree | null

const als = new AsyncLocalStorage<RunTree>()
const posted = new WeakSet<RunTree>()

function toTraceSafeValue(value: any): any {
  if (value == null) return value
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return value
  if (Array.isArray(value)) return value.map((item) => toTraceSafeValue(item))
  if (t === 'object') {
    // 避免直接写入不可序列化对象（如 Response/Request/Error 等）
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
      }
    }
    if ('status' in value && 'ok' in value && 'headers' in value) {
      return {
        status: (value as any).status,
        ok: (value as any).ok,
      }
    }
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = toTraceSafeValue(v)
    }
    return out
  }
  return String(value)
}

function envTrue(v?: string) {
  if (!v) return false
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())
}

export function isLangSmithEnabled() {
  // 只要有 API key 就认为可用；允许用户用开关强制关闭
  if (envTrue(process.env.LANGSMITH_DISABLED)) return false
  // 跟 LangSmith 约定一致：需要显式开启 tracing
  const tracingOn = envTrue(process.env.LANGSMITH_TRACING) || envTrue(process.env.LANGSMITH_TRACING_V2)
  return tracingOn && !!process.env.LANGSMITH_API_KEY
}

export function getActiveRun(): MaybeRunTree {
  return als.getStore() ?? null
}

export async function withLangSmithRootRun<T>(
  opts: {
    name: string
    runType?: string
    inputs?: any
    tags?: string[]
    metadata?: Record<string, any>
  },
  fn: (run: RunTree) => Promise<T>,
) {
  if (!isLangSmithEnabled()) return await fn(null as any)

  const run = new RunTree({
    name: opts.name,
    run_type: opts.runType ?? 'chain',
    inputs: opts.inputs ?? {},
    tags: opts.tags,
    metadata: opts.metadata,
    // 为了更好地跨系统关联日志/追踪
    id: randomUUID(),
  } as any)

  // 关键：先把 root run 注册到 LangSmith，避免后续卡在 agent.generate/tool-call 解析时“看不到 run”
  try {
    if (!posted.has(run)) {
      await run.postRun()
      posted.add(run)
    }
  } catch {
    // 忽略：网络/权限问题不应影响业务请求
  }

  return await als.run(run, async () => {
    try {
      const result = await fn(run)
      return result
    } catch (err) {
      try {
        await run.end(undefined, err instanceof Error ? err.message : String(err))
        await run.patchRun()
      } catch {}
      throw err
    } finally {
      // 正常路径下由调用者负责 end/post（需要输出内容）
    }
  })
}

export function requestTraceMeta(c: Context) {
  try {
    const url = new URL(c.req.url)
    return {
      method: c.req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      userAgent: c.req.header('user-agent') || '',
    }
  } catch {
    return { method: c.req.method }
  }
}

export async function withLangSmithChildRun<T>(
  opts: {
    name: string
    runType?: string
    inputs?: any
    tags?: string[]
    metadata?: Record<string, any>
    mapOutput?: (result: T) => any
  },
  fn: () => Promise<T>,
) {
  const parent = getActiveRun()
  const child = parent?.createChild({
    name: opts.name,
    run_type: opts.runType ?? 'tool',
    inputs: opts.inputs ?? {},
    tags: opts.tags,
    metadata: opts.metadata,
  } as any)

  try {
    const result = await fn()
    if (child) {
      const output = opts.mapOutput ? opts.mapOutput(result) : result
      child.end({ output: toTraceSafeValue(output) } as any)
      await child.postRun()
    }
    return result
  } catch (err) {
    if (child) {
      child.end(undefined, err instanceof Error ? err.message : String(err))
      try {
        await child.postRun()
      } catch {}
    }
    throw err
  }
}

