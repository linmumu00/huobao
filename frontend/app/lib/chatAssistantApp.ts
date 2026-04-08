/**
 * Assistant UI 聊天壳（供 chat.vue 挂载），与 Vue 通过 props 传入 dramaId / episodeId。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AssistantRuntimeProvider,
  useAui,
  useLocalRuntime,
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  useMessagePartText,
} from '@assistant-ui/react'
import { renderMarkdown } from '~/lib/markdown'

export type ChatAssistantProps = {
  dramaId: string
  episodeId: string
  onAfterRun?: () => void | Promise<void>
}

function parsePlanLines(text: string): string[] {
  return text
    .split(/\n/)
    .map((line) =>
      line
        .replace(/^\s*[-*•]\s*/, '')
        .replace(/^\d+[\.\)、]\s*/, '')
        .trim(),
    )
    .filter(Boolean)
}

type ToolCallEntry = { toolName: string | null; args: unknown }
type ToolResultEntry = { toolName: string | null; result: string }

type TraceState = {
  toolCalls: ToolCallEntry[]
  toolResults: ToolResultEntry[]
} | null

type PlanPanelProps = {
  planText: string
  setPlanText: (v: string) => void
  setErrorMsg: (v: string) => void
  idsReady: boolean
}

/** 必须在 AssistantRuntimeProvider 内：一键执行用 thread.append 触发模型运行 */
function PlanPanelInner({ planText, setPlanText, setErrorMsg, idsReady }: PlanPanelProps) {
  const aui = useAui()

  const onPreviewPlan = useCallback(() => {
    setErrorMsg('')
    const ta =
      document.querySelector<HTMLTextAreaElement>('.aui-composer textarea') ||
      document.querySelector<HTMLTextAreaElement>('textarea[name="input"]')
    const src = ta?.value?.trim() || ''
    if (!src) {
      setErrorMsg('请先在下方输入框中填写任务描述')
      return
    }
    const lines = parsePlanLines(src)
    setPlanText(lines.map((l, i) => `${i + 1}. ${l}`).join('\n'))
  }, [setErrorMsg, setPlanText])

  const onExecutePlan = useCallback(() => {
    const msg = planText.trim()
    if (!msg) {
      setErrorMsg('请填写执行计划预览内容，或先「从输入生成预览」')
      return
    }
    if (!idsReady) {
      setErrorMsg('请先在左侧选择项目与剧集')
      return
    }
    setErrorMsg('')
    aui.thread().append({
      role: 'user',
      content: [{ type: 'text', text: msg }],
    })
  }, [aui, idsReady, planText, setErrorMsg])

  return React.createElement(
    'div',
    { className: 'aui-plan-panel' },
    React.createElement(
      'div',
      { className: 'aui-plan-head' },
      React.createElement('div', { className: 'aui-plan-title' }, '执行计划预览'),
      React.createElement(
        'div',
        { className: 'aui-plan-actions' },
        React.createElement(
          'button',
          { type: 'button', className: 'aui-btn', onClick: onPreviewPlan },
          '从输入生成预览',
        ),
        React.createElement(
          'button',
          { type: 'button', className: 'aui-btn aui-btn-primary', onClick: onExecutePlan },
          '一键执行',
        ),
      ),
    ),
    React.createElement('textarea', {
      className: 'aui-plan-textarea',
      placeholder: '点击「从输入生成预览」将下方输入框按行拆解为步骤；也可直接编辑。',
      value: planText,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setPlanText(e.target.value),
    }),
    !planText.trim()
      ? React.createElement(
          'div',
          { className: 'aui-plan-empty' },
          '一键执行将把上方文本作为用户消息发给 Agent（与点「发送」等价）。',
        )
      : null,
  )
}

type HistoryLoaderProps = {
  dramaId: string
  episodeId: string
  setErrorMsg: (v: string) => void
}

/** 必须在 AssistantRuntimeProvider 内：用 thread.reset 灌入历史对话 */
function HistoryLoaderInner({ dramaId, episodeId, setErrorMsg }: HistoryLoaderProps) {
  const aui = useAui()

  useEffect(() => {
    const drId = Number(dramaId)
    const epId = Number(episodeId)
    if (!drId || !epId) {
      // 清空线程
      aui.thread().reset([])
      return
    }

    const controller = new AbortController()
    ;(async () => {
      try {
        const resp = await fetch(`/api/v1/chat/messages?drama_id=${drId}&episode_id=${epId}&limit=200`, {
          signal: controller.signal,
        })
        const json = await resp.json()
        if (!resp.ok || (json?.code && json.code >= 400)) {
          throw new Error(json?.message || `历史加载失败: ${resp.status}`)
        }
        const rows = Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : [])
        const initial = rows.map((r: any) => ({
          role: r.role,
          content: [{ type: 'text', text: r.content || '' }],
          // 避免历史 user 消息触发 run
          startRun: false,
        }))
        aui.thread().reset(initial)
      } catch (e: any) {
        if (e?.name === 'AbortError') return
        setErrorMsg(e?.message || '历史对话加载失败')
      }
    })()

    return () => controller.abort()
  }, [aui, dramaId, episodeId, setErrorMsg])

  return null
}

function MarkdownTextPart() {
  const { text } = useMessagePartText()
  return React.createElement('div', {
    className: 'aui-md',
    dangerouslySetInnerHTML: { __html: renderMarkdown(text || '') },
  })
}

export function createChatAssistantApp() {
  return function ChatAssistantApp({ dramaId, episodeId, onAfterRun }: ChatAssistantProps) {
    const [errorMsg, setErrorMsg] = useState('')
    const [planText, setPlanText] = useState('')
    const [trace, setTrace] = useState<TraceState>(null)

    const idsReady = useMemo(
      () => Boolean(dramaId && episodeId && Number(dramaId) > 0 && Number(episodeId) > 0),
      [dramaId, episodeId],
    )

    const runtime = useLocalRuntime({
      async run({ messages, abortSignal }: any) {
        setErrorMsg('')
        setTrace(null)
        const last = [...messages].reverse().find((msg: any) => msg?.role === 'user')
        const latestText = Array.isArray(last?.content)
          ? last.content
              .filter((p: any) => p?.type === 'text')
              .map((p: any) => p.text || '')
              .join('\n')
          : ''

        const payload = {
          message: latestText,
          drama_id: Number(dramaId),
          episode_id: Number(episodeId),
        }
        if (!payload.drama_id || !payload.episode_id) {
          throw new Error('请先在左侧选择项目与剧集')
        }

        const resp = await fetch(`/api/v1/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: abortSignal,
        })
        const json = await resp.json()
        if (!resp.ok || (json?.code && json.code >= 400)) {
          const msg = json?.message || `请求失败: ${resp.status}`
          setErrorMsg(msg)
          throw new Error(msg)
        }

        const data = json?.data ?? json
        const toolCalls = Array.isArray(data?.toolCalls) ? data.toolCalls : []
        const toolResults = Array.isArray(data?.toolResults) ? data.toolResults : []
        setTrace({ toolCalls, toolResults })

        // 通知外层（Vue）刷新上下文/进度
        try { await onAfterRun?.() } catch {}

        return {
          content: [{ type: 'text', text: data?.text || '' }],
        }
      },
    })

    return React.createElement(
      'div',
      { className: 'aui-shell' },
      React.createElement(
        'div',
        { className: 'aui-toolbar' },
        React.createElement('div', { className: 'aui-field' },
          React.createElement('span', null, 'Agent'),
          React.createElement('input', { value: 'chat_orchestrator', readOnly: true }),
        ),
        React.createElement(
          'label',
          { className: 'aui-field' },
          React.createElement('span', null, 'drama_id'),
          React.createElement('input', { value: dramaId || '—', readOnly: true }),
        ),
        React.createElement(
          'label',
          { className: 'aui-field' },
          React.createElement('span', null, 'episode_id'),
          React.createElement('input', { value: episodeId || '—', readOnly: true }),
        ),
      ),
      React.createElement(
        'div',
        { className: 'aui-hint' },
        idsReady
          ? '下方输入任务说明；可先「从输入生成预览」确认步骤，再「一键执行」或直接在输入框点发送。'
          : '请先在左栏选择项目与剧集。',
      ),
      errorMsg ? React.createElement('div', { className: 'aui-error' }, errorMsg) : null,
      React.createElement(
        AssistantRuntimeProvider,
        { runtime },
        React.createElement(HistoryLoaderInner, {
          dramaId,
          episodeId,
          setErrorMsg,
        }),
        React.createElement(PlanPanelInner, {
          planText,
          setPlanText,
          setErrorMsg,
          idsReady,
        }),
        React.createElement(
          'div',
          { className: 'aui-thread-wrap' },
          React.createElement(
            ThreadPrimitive.Root,
            { className: 'aui-thread' },
            React.createElement(
              ThreadPrimitive.Viewport,
              { className: 'aui-viewport' },
              React.createElement((ThreadPrimitive.Messages as any), {
                children: () =>
                  React.createElement(
                    MessagePrimitive.Root,
                    { className: 'aui-message-row' },
                    React.createElement(
                      MessagePrimitive.If,
                      { user: true },
                      React.createElement(
                        'div',
                        { className: 'aui-message user' },
                        React.createElement(MessagePrimitive.Parts, { components: { Text: MarkdownTextPart } }),
                      ),
                    ),
                    React.createElement(
                      MessagePrimitive.If,
                      { assistant: true },
                      React.createElement(
                        'div',
                        { className: 'aui-message assistant' },
                        React.createElement(MessagePrimitive.Parts, { components: { Text: MarkdownTextPart } }),
                      ),
                    ),
                  ),
              }),
            ),
            React.createElement(
              ThreadPrimitive.ViewportFooter,
              { className: 'aui-footer' },
              React.createElement(
                ComposerPrimitive.Root,
                { className: 'aui-composer' },
                React.createElement(ComposerPrimitive.Input, {
                  className: 'aui-input',
                  name: 'input',
                  placeholder: '输入你想执行的生产任务…',
                  rows: 3,
                }),
                React.createElement('button', { type: 'submit', className: 'aui-send' }, '发送'),
              ),
            ),
          ),
        ),
      ),
      React.createElement(
        'div',
        { className: 'aui-trace' },
        React.createElement('div', { className: 'aui-trace-head' }, '工具调用追踪（最近一次）'),
        !trace || (!trace.toolCalls?.length && !trace.toolResults?.length)
          ? React.createElement(
              'div',
              { className: 'aui-trace-empty' },
              '尚无执行记录；成功调用 Agent 后在此展示 toolCalls / toolResults。',
            )
          : React.createElement(
              'div',
              { className: 'aui-trace-list' },
              trace.toolCalls.map((tc, i) =>
                React.createElement(
                  'details',
                  { key: `call-${i}`, className: 'aui-trace-item', open: i === 0 },
                  React.createElement(
                    'summary',
                    null,
                    React.createElement('span', { className: 'aui-trace-badge' }, 'call'),
                    tc.toolName || '(unknown tool)',
                  ),
                  React.createElement(
                    'div',
                    { className: 'aui-trace-body' },
                    React.createElement('div', null, '参数 args'),
                    React.createElement(
                      'pre',
                      { className: 'aui-trace-pre' },
                      typeof tc.args === 'string'
                        ? tc.args
                        : JSON.stringify(tc.args, null, 2),
                    ),
                  ),
                ),
              ),
              trace.toolResults.map((tr, i) =>
                React.createElement(
                  'details',
                  { key: `res-${i}`, className: 'aui-trace-item', open: false },
                  React.createElement(
                    'summary',
                    null,
                    React.createElement('span', { className: 'aui-trace-badge' }, 'result'),
                    tr.toolName || '(unknown tool)',
                  ),
                  React.createElement(
                    'div',
                    { className: 'aui-trace-body' },
                    React.createElement('pre', { className: 'aui-trace-pre' }, tr.result),
                  ),
                ),
              ),
            ),
      ),
    )
  }
}
