import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { getActiveConfig, getConfigById } from "./ai.js";
import { now } from "../utils/response.js";
import {
  downloadFile,
  readImageAsCompressedDataUrl,
} from "../utils/storage.js";
import { getVideoAdapter } from "./adapters/registry";
import type { AIConfig } from "./adapters/types";
import {
  logTaskError,
  logTaskPayload,
  logTaskProgress,
  logTaskStart,
  logTaskSuccess,
  logTaskWarn,
  redactUrl,
} from "../utils/task-logger.js";
import {
  withLangSmithChildRun,
  withLangSmithRootRun,
} from "../observability/langsmith.js";

interface GenerateVideoParams {
  storyboardId?: number;
  dramaId?: number;
  prompt: string;
  model?: string;
  referenceMode?: string;
  imageUrl?: string;
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  referenceImageUrls?: string[];
  duration?: number;
  aspectRatio?: string;
  configId?: number;
}

function mergePromptWithStyle(prompt: string, style?: string | null) {
  const basePrompt = String(prompt || "").trim();
  const styleText = String(style || "").trim();
  if (!styleText) return basePrompt;
  if (basePrompt.includes(styleText)) return basePrompt;
  return `${basePrompt}\n\n项目风格要求：${styleText}，需要写实风格`;
}

function resolveDramaStyle(
  dramaId?: number | null,
  storyboardId?: number | null,
) {
  let resolvedDramaId = dramaId || null;
  if (!resolvedDramaId && storyboardId) {
    const [sb] = db
      .select()
      .from(schema.storyboards)
      .where(eq(schema.storyboards.id, storyboardId))
      .all();
    if (sb) {
      const [ep] = db
        .select()
        .from(schema.episodes)
        .where(eq(schema.episodes.id, sb.episodeId))
        .all();
      resolvedDramaId = ep?.dramaId || null;
    }
  }
  if (!resolvedDramaId) return null;
  const [drama] = db
    .select()
    .from(schema.dramas)
    .where(eq(schema.dramas.id, resolvedDramaId))
    .all();
  return drama?.style || null;
}

export async function generateVideo(
  params: GenerateVideoParams,
): Promise<number> {
  const ts = now();
  const config = params.configId
    ? getConfigById(params.configId)
    : getActiveConfig("video");
  if (!config) throw new Error("No active video AI config");
  const dramaStyle = resolveDramaStyle(params.dramaId, params.storyboardId);
  const promptWithStyle = mergePromptWithStyle(params.prompt, dramaStyle);

  const res = db
    .insert(schema.videoGenerations)
    .values({
      storyboardId: params.storyboardId,
      dramaId: params.dramaId,
      prompt: promptWithStyle,
      model: params.model || config.model,
      provider: config.provider,
      referenceMode: params.referenceMode || "none",
      imageUrl: params.imageUrl,
      firstFrameUrl: params.firstFrameUrl,
      lastFrameUrl: params.lastFrameUrl,
      referenceImageUrls: params.referenceImageUrls
        ? JSON.stringify(params.referenceImageUrls)
        : null,
      duration: params.duration || 5,
      aspectRatio: params.aspectRatio || "16:9",
      status: "processing",
      createdAt: ts,
      updatedAt: ts,
    })
    .run();

  const lastId = Number(res.lastInsertRowid);
  logTaskStart("VideoTask", "enqueue", {
    id: lastId,
    provider: config.provider,
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    referenceMode: params.referenceMode || "none",
    duration: params.duration || 5,
  });
  logTaskPayload("VideoTask", "enqueue params", {
    id: lastId,
    config: {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
    },
    params: {
      ...params,
      prompt: promptWithStyle,
      dramaStyle: dramaStyle || undefined,
    },
  });
  withLangSmithRootRun(
    {
      name: "media:video_generation",
      runType: "chain",
      inputs: {
        videoGenerationId: lastId,
        provider: config.provider,
        model: params.model || config.model,
        storyboardId: params.storyboardId,
        dramaId: params.dramaId,
      },
      tags: ["service:video", "media-generation"],
    },
    async (run) => {
      const traceResult = await processVideoGeneration(lastId, config);
      if (run) {
        await run.end({
          videoGenerationId: lastId,
          ...traceResult,
        });
        await run.patchRun();
      }
    },
  ).catch((err) => {
    logTaskError("VideoTask", "process", { id: lastId, error: err.message });
    console.error(`Video generation ${lastId} failed:`, err);
  });
  return lastId;
}

async function processVideoGeneration(id: number, config: AIConfig) {
  const adapter = getVideoAdapter(config.provider);

  try {
    const rows = db
      .select()
      .from(schema.videoGenerations)
      .where(eq(schema.videoGenerations.id, id))
      .all();
    const record = rows[0];
    if (!record) return { status: "missing" as const };
    logTaskProgress("VideoTask", "build-request", {
      id,
      provider: config.provider,
      storyboardId: record.storyboardId,
      referenceMode: record.referenceMode,
    });

    const resolvedImageUrl = await normalizeVideoReferenceUrl(record.imageUrl);
    const resolvedFirstFrameUrl = await normalizeVideoReferenceUrl(
      record.firstFrameUrl,
    );
    const resolvedLastFrameUrl = await normalizeVideoReferenceUrl(
      record.lastFrameUrl,
    );
    const resolvedReferenceImageUrls = await normalizeVideoReferenceUrls(
      record.referenceImageUrls,
    );

    // 使用 Adapter 构建请求
    const { url, method, headers, body } = adapter.buildGenerateRequest(
      config,
      {
        id: record.id,
        model: record.model,
        prompt: record.prompt,
        referenceMode: record.referenceMode,
        imageUrl: resolvedImageUrl,
        firstFrameUrl: resolvedFirstFrameUrl,
        lastFrameUrl: resolvedLastFrameUrl,
        referenceImageUrls: resolvedReferenceImageUrls
          ? JSON.stringify(resolvedReferenceImageUrls)
          : null,
        duration: record.duration,
        aspectRatio: record.aspectRatio,
      },
    );
    logTaskProgress("VideoTask", "request", {
      id,
      provider: config.provider,
      method,
      url: redactUrl(url),
      model: record.model,
      referenceMode: record.referenceMode,
    });
    logTaskPayload("VideoTask", "request payload", {
      id,
      method,
      url,
      headers,
      body,
    });

    const resp = await withLangSmithChildRun(
      {
        name: "video:generate_request",
        runType: "llm",
        inputs: {
          videoGenerationId: id,
          provider: config.provider,
          url: redactUrl(url),
          method,
          model: record.model,
          body,
        },
        tags: ["service:video", "provider:request"],
        mapOutput: (response) => ({
          status: response.status,
          ok: response.ok,
        }),
      },
      async () =>
        fetch(url, {
          method,
          headers,
          body: JSON.stringify(body),
        }),
    );

    if (!resp.ok)
      throw new Error(`API error ${resp.status}: ${await resp.text()}`);
    const result = (await resp.json()) as any;

    const { isAsync, taskId, videoUrl } = adapter.parseGenerateResponse(result);
    await withLangSmithChildRun(
      {
        name: "video:parse_generate_response",
        runType: "parser",
        inputs: {
          videoGenerationId: id,
          provider: config.provider,
        },
        tags: ["service:video", "provider:response"],
      },
      async () => ({
        isAsync,
        taskId: taskId || null,
        videoUrl: videoUrl || null,
      }),
    );

    if (!isAsync && videoUrl) {
      logTaskProgress("VideoTask", "sync-complete", { id, videoUrl });
      // 同步模式
      const completion = await handleVideoComplete(id, videoUrl, record.duration);
      return {
        status: "completed" as const,
        mode: "sync_url" as const,
        videoUrl: completion.videoUrl,
        localPath: completion.localPath,
      };
    }

    // 异步模式：更新 taskId，开始轮询
    db.update(schema.videoGenerations)
      .set({ taskId, status: "processing", updatedAt: now() })
      .where(eq(schema.videoGenerations.id, id))
      .run();
    logTaskProgress("VideoTask", "poll-start", {
      id,
      taskId,
      provider: config.provider,
    });

    // Vidu 没有轮询端点，跳过轮询（依赖 Webhook 回调）
    if (adapter.provider === "vidu") {
      logTaskProgress("VideoTask", "webhook-wait", {
        id,
        taskId,
        provider: adapter.provider,
      });
      return {
        status: "pending" as const,
        mode: "webhook_wait" as const,
        taskId,
      };
    }

    return await pollVideoTask(id, config, taskId!, record.storyboardId);
  } catch (err: any) {
    logTaskError("VideoTask", "process", {
      id,
      provider: config.provider,
      error: err.message,
    });
    db.update(schema.videoGenerations)
      .set({ status: "failed", errorMsg: err.message, updatedAt: now() })
      .where(eq(schema.videoGenerations.id, id))
      .run();
    return { status: "failed" as const, error: err.message };
  }
}

async function normalizeVideoReferenceUrl(
  value: string | null | undefined,
): Promise<string | null> {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (raw.startsWith("data:image/")) return raw;
  if (raw.startsWith("static/") || raw.startsWith("/static/")) {
    const localPath = raw.startsWith("/static/") ? raw.slice(1) : raw;
    try {
      return await readImageAsCompressedDataUrl(localPath, {
        maxWidth: 768,
        maxHeight: 768,
        quality: 68,
      });
    } catch (err) {
      logTaskWarn("VideoTask", "reference-read-failed", {
        path: localPath,
        error: (err as Error).message,
      });
      return null;
    }
  }
  return raw;
}

async function normalizeVideoReferenceUrls(
  raw: string | null | undefined,
): Promise<string[]> {
  if (!raw) return [];
  let refs: string[] = [];
  try {
    refs = JSON.parse(raw);
  } catch {
    refs = [];
  }
  const normalized = await Promise.all(
    Array.from(
      new Set(refs.map((item) => String(item || "").trim()).filter(Boolean)),
    ).map((item) => normalizeVideoReferenceUrl(item)),
  );
  return normalized.filter((item): item is string => !!item);
}

async function pollVideoTask(
  id: number,
  config: AIConfig,
  taskId: string,
  storyboardId?: number | null,
) {
  const adapter = getVideoAdapter(config.provider);

  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    try {
      const { url, method, headers } = adapter.buildPollRequest(config, taskId);
      logTaskProgress("VideoTask", "poll-request", {
        id,
        taskId,
        provider: config.provider,
        method,
        url: redactUrl(url),
        attempt: i + 1,
      });
      const resp = await withLangSmithChildRun(
        {
          name: "video:poll_request",
          runType: "retriever",
          inputs: {
            videoGenerationId: id,
            taskId,
            provider: config.provider,
            attempt: i + 1,
            url: redactUrl(url),
            method,
          },
          tags: ["service:video", "provider:poll"],
          mapOutput: (response) => ({
            status: response.status,
            ok: response.ok,
            attempt: i + 1,
          }),
        },
        async () => fetch(url, { method, headers }),
      );
      if (!resp.ok) continue;
      const result = (await resp.json()) as any;

      const pollResp = adapter.parsePollResponse(result);
      await withLangSmithChildRun(
        {
          name: "video:parse_poll_response",
          runType: "parser",
          inputs: {
            videoGenerationId: id,
            taskId,
            attempt: i + 1,
          },
          tags: ["service:video", "provider:poll-response"],
        },
        async () => ({
          status: pollResp.status,
          videoUrl: pollResp.videoUrl || null,
          error: pollResp.error || null,
        }),
      );

      if (pollResp.status === "completed" && pollResp.videoUrl) {
        logTaskSuccess("VideoTask", "poll-complete", {
          id,
          taskId,
          videoUrl: pollResp.videoUrl,
        });
        const completion = await handleVideoComplete(
          id,
          pollResp.videoUrl,
          null,
          storyboardId,
        );
        return {
          status: "completed" as const,
          mode: "poll_url" as const,
          videoUrl: completion.videoUrl,
          localPath: completion.localPath,
        };
      }
      if (pollResp.status === "failed") {
        logTaskError("VideoTask", "poll-failed", {
          id,
          taskId,
          error: pollResp.error || "Video generation failed",
        });
        throw new Error(pollResp.error || "Video generation failed");
      }
    } catch (err: any) {
      if (i === 299) {
        logTaskError("VideoTask", "poll-timeout", {
          id,
          taskId,
          error: err.message,
        });
        db.update(schema.videoGenerations)
          .set({
            status: "failed",
            errorMsg: `Timeout: ${err.message}`,
            updatedAt: now(),
          })
          .where(eq(schema.videoGenerations.id, id))
          .run();
        return { status: "failed" as const, error: `Timeout: ${err.message}` };
      }
      logTaskWarn("VideoTask", "poll-retry", {
        id,
        taskId,
        attempt: i + 1,
        error: err.message,
      });
    }
  }
  return { status: "failed" as const, error: "Polling attempts exhausted" };
}

async function handleVideoComplete(
  id: number,
  videoUrl: string,
  duration: number | null | undefined,
  storyboardId?: number | null,
) {
  const localPath = await downloadFile(videoUrl, "videos");
  db.update(schema.videoGenerations)
    .set({
      videoUrl,
      localPath,
      status: "completed",
      completedAt: now(),
      updatedAt: now(),
    })
    .where(eq(schema.videoGenerations.id, id))
    .run();
  logTaskSuccess("VideoTask", "downloaded", {
    id,
    localPath,
    storyboardId,
    duration,
  });

  if (storyboardId) {
    db.update(schema.storyboards)
      .set({
        videoUrl: localPath,
        duration: duration || undefined,
        updatedAt: now(),
      })
      .where(eq(schema.storyboards.id, storyboardId))
      .run();
  }
  return { videoUrl, localPath };
}
