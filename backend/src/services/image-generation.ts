import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { getActiveConfig, getConfigById } from "./ai.js";
import { now } from "../utils/response.js";
import {
  downloadFile,
  readImageAsCompressedDataUrl,
  saveBase64Image,
} from "../utils/storage.js";
import { getImageAdapter } from "./adapters/registry";
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

interface GenerateImageParams {
  storyboardId?: number;
  dramaId?: number;
  sceneId?: number;
  characterId?: number;
  prompt: string;
  model?: string;
  size?: string;
  referenceImages?: string[];
  frameType?: string;
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

export async function generateImage(
  params: GenerateImageParams,
): Promise<number> {
  const ts = now();
  const config = params.configId
    ? getConfigById(params.configId)
    : getActiveConfig("image");
  if (!config) throw new Error("No active image AI config");
  const dramaStyle = resolveDramaStyle(params.dramaId, params.storyboardId);
  const promptWithStyle = mergePromptWithStyle(params.prompt, dramaStyle);

  const res = db
    .insert(schema.imageGenerations)
    .values({
      storyboardId: params.storyboardId,
      dramaId: params.dramaId,
      sceneId: params.sceneId,
      characterId: params.characterId,
      prompt: promptWithStyle,
      model: params.model || config.model,
      provider: config.provider,
      size: params.size || "1920x1080",
      frameType: params.frameType,
      referenceImages: params.referenceImages
        ? JSON.stringify(params.referenceImages)
        : null,
      status: "processing",
      createdAt: ts,
      updatedAt: ts,
    })
    .run();

  const lastId = Number(res.lastInsertRowid);
  logTaskStart("ImageTask", "enqueue", {
    id: lastId,
    provider: config.provider,
    storyboardId: params.storyboardId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    frameType: params.frameType,
    model: params.model || config.model,
  });
  logTaskPayload("ImageTask", "enqueue params", {
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
      name: "media:image_generation",
      runType: "chain",
      inputs: {
        imageGenerationId: lastId,
        provider: config.provider,
        model: params.model || config.model,
        storyboardId: params.storyboardId,
        sceneId: params.sceneId,
        characterId: params.characterId,
      },
      tags: ["service:image", "media-generation"],
    },
    async (run) => {
      const traceResult = await processImageGeneration(lastId, config);
      if (run) {
        await run.end({
          imageGenerationId: lastId,
          ...traceResult,
        });
        await run.patchRun();
      }
    },
  ).catch((err) => {
    logTaskError("ImageTask", "process", { id: lastId, error: err.message });
    console.error(`Image generation ${lastId} failed:`, err);
  });
  return lastId;
}

async function processImageGeneration(id: number, config: AIConfig) {
  const adapter = getImageAdapter(config.provider);

  try {
    const rows = db
      .select()
      .from(schema.imageGenerations)
      .where(eq(schema.imageGenerations.id, id))
      .all();
    const record = rows[0];
    if (!record) return { status: "missing" as const };
    logTaskProgress("ImageTask", "build-request", {
      id,
      provider: config.provider,
      storyboardId: record.storyboardId,
      sceneId: record.sceneId,
      characterId: record.characterId,
      frameType: record.frameType,
    });

    // 使用 Adapter 构建请求
    const resolvedReferenceImages = await normalizeReferenceImages(
      record.referenceImages,
    );
    const { url, method, headers, body } = adapter.buildGenerateRequest(
      config,
      {
        id: record.id,
        model: record.model,
        prompt: record.prompt,
        size: record.size,
        frameType: record.frameType,
        referenceImages: resolvedReferenceImages
          ? JSON.stringify(resolvedReferenceImages)
          : null,
      },
    );
    logTaskProgress("ImageTask", "request", {
      id,
      provider: config.provider,
      method,
      url: redactUrl(url),
      model: record.model,
    });
    logTaskPayload("ImageTask", "request payload", {
      id,
      method,
      url,
      headers,
      body,
    });

    const resp = await withLangSmithChildRun(
      {
        name: "image:generate_request",
        runType: "llm",
        inputs: {
          imageGenerationId: id,
          provider: config.provider,
          url: redactUrl(url),
          method,
          model: record.model,
          body,
        },
        tags: ["service:image", "provider:request"],
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
          signal: AbortSignal.timeout(600_000),
        }),
    );

    if (!resp.ok)
      throw new Error(`API error ${resp.status}: ${await resp.text()}`);
    const result = (await resp.json()) as any;
    logTaskPayload("ImageTask", "response payload", {
      id,
      provider: config.provider,
      result,
    });

    const { isAsync, taskId, imageUrl } = adapter.parseGenerateResponse(result);
    const base64Payload = !isAsync && !imageUrl ? adapter.extractImageBase64(result) : null;
    await withLangSmithChildRun(
      {
        name: "image:parse_generate_response",
        runType: "parser",
        inputs: {
          imageGenerationId: id,
          provider: config.provider,
        },
        tags: ["service:image", "provider:response"],
      },
      async () => ({
        isAsync,
        taskId: taskId || null,
        imageUrl: imageUrl || null,
        hasBase64: !!base64Payload,
        base64MimeType: base64Payload?.mimeType || null,
      }),
    );

    if (!isAsync && imageUrl) {
      logTaskProgress("ImageTask", "sync-complete", { id, imageUrl });
      // 同步模式：直接下载图片
      const completion = await handleImageComplete(id, config.provider, imageUrl);
      return {
        status: "completed" as const,
        mode: "sync_url" as const,
        imageUrl: completion.imageUrl,
        localPath: completion.localPath,
      };
    }

    if (!isAsync && !imageUrl) {
      // 同步模式但无 URL（Gemini 等返回 base64）
      const b64 = base64Payload ?? adapter.extractImageBase64(result);
      if (b64) {
        logTaskProgress("ImageTask", "sync-base64-complete", {
          id,
          mimeType: b64.mimeType,
        });
        const completion = await handleImageCompleteBase64(
          id,
          config.provider,
          b64.data,
          b64.mimeType,
        );
        return {
          status: "completed" as const,
          mode: "sync_base64" as const,
          localPath: completion.localPath,
          mimeType: b64.mimeType,
        };
      }
      throw new Error("No image URL or base64 data in response");
    }

    // 异步模式：更新 taskId，开始轮询
    db.update(schema.imageGenerations)
      .set({ taskId, status: "processing", updatedAt: now() })
      .where(eq(schema.imageGenerations.id, id))
      .run();
    logTaskProgress("ImageTask", "poll-start", {
      id,
      taskId,
      provider: config.provider,
    });
    return await pollImageTask(id, config, taskId!);
  } catch (err: any) {
    logTaskError("ImageTask", "process", {
      id,
      provider: config.provider,
      error: err.message,
    });
    db.update(schema.imageGenerations)
      .set({ status: "failed", errorMsg: err.message, updatedAt: now() })
      .where(eq(schema.imageGenerations.id, id))
      .run();
    return { status: "failed" as const, error: err.message };
  }
}

async function normalizeReferenceImages(
  raw: string | null | undefined,
): Promise<string[]> {
  if (!raw) return [];
  let refs: string[] = [];
  try {
    refs = JSON.parse(raw);
  } catch {
    refs = [];
  }

  const deduped = Array.from(
    new Set(refs.map((item) => String(item || "").trim()).filter(Boolean)),
  );

  const normalized = await Promise.all(
    deduped.map(async (value) => {
      if (value.startsWith("data:image/")) return value;
      if (value.startsWith("static/") || value.startsWith("/static/")) {
        const localPath = value.startsWith("/static/") ? value.slice(1) : value;
        try {
          return await readImageAsCompressedDataUrl(localPath, {
            maxWidth: 768,
            maxHeight: 768,
            quality: 68,
          });
        } catch (err) {
          logTaskWarn("ImageTask", "reference-read-failed", {
            path: localPath,
            error: (err as Error).message,
          });
          return null;
        }
      }
      return value;
    }),
  );

  return normalized.filter((item): item is string => !!item).slice(0, 6);
}

async function pollImageTask(id: number, config: AIConfig, taskId: string) {
  const adapter = getImageAdapter(config.provider);
  const startedAt = Date.now();
  const maxDurationMs = 600_000;

  for (let i = 0; i < 120; i++) {
    if (Date.now() - startedAt >= maxDurationMs) {
      logTaskError("ImageTask", "poll-timeout", {
        id,
        taskId,
        error: "Polling exceeded 10 minutes",
      });
      db.update(schema.imageGenerations)
        .set({
          status: "failed",
          errorMsg: "Timeout: Polling exceeded 10 minutes",
          updatedAt: now(),
        })
        .where(eq(schema.imageGenerations.id, id))
        .run();
      return {
        status: "failed" as const,
        error: "Timeout: Polling exceeded 10 minutes",
      };
    }
    await new Promise((r) => setTimeout(r, 5000));
    if (Date.now() - startedAt >= maxDurationMs) {
      logTaskError("ImageTask", "poll-timeout", {
        id,
        taskId,
        error: "Polling exceeded 10 minutes",
      });
      db.update(schema.imageGenerations)
        .set({
          status: "failed",
          errorMsg: "Timeout: Polling exceeded 10 minutes",
          updatedAt: now(),
        })
        .where(eq(schema.imageGenerations.id, id))
        .run();
      return {
        status: "failed" as const,
        error: "Timeout: Polling exceeded 10 minutes",
      };
    }
    try {
      const { url, method, headers } = adapter.buildPollRequest(config, taskId);
      logTaskProgress("ImageTask", "poll-request", {
        id,
        taskId,
        provider: config.provider,
        method,
        url: redactUrl(url),
        attempt: i + 1,
      });
      const remainingMs = Math.max(
        1_000,
        maxDurationMs - (Date.now() - startedAt),
      );
      const resp = await withLangSmithChildRun(
        {
          name: "image:poll_request",
          runType: "retriever",
          inputs: {
            imageGenerationId: id,
            taskId,
            provider: config.provider,
            attempt: i + 1,
            url: redactUrl(url),
            method,
          },
          tags: ["service:image", "provider:poll"],
          mapOutput: (response) => ({
            status: response.status,
            ok: response.ok,
            attempt: i + 1,
          }),
        },
        async () =>
          fetch(url, {
            method,
            headers,
            signal: AbortSignal.timeout(remainingMs),
          }),
      );
      if (!resp.ok) continue;
      const result = (await resp.json()) as any;

      const pollResp = adapter.parsePollResponse(result);
      await withLangSmithChildRun(
        {
          name: "image:parse_poll_response",
          runType: "parser",
          inputs: {
            imageGenerationId: id,
            taskId,
            attempt: i + 1,
          },
          tags: ["service:image", "provider:poll-response"],
        },
        async () => ({
          status: pollResp.status,
          imageUrl: pollResp.imageUrl || null,
          error: pollResp.error || null,
        }),
      );

      if (pollResp.status === "completed" && pollResp.imageUrl) {
        logTaskSuccess("ImageTask", "poll-complete", {
          id,
          taskId,
          imageUrl: pollResp.imageUrl,
        });
        const completion = await handleImageComplete(
          id,
          config.provider,
          pollResp.imageUrl,
        );
        return {
          status: "completed" as const,
          mode: "poll_url" as const,
          imageUrl: completion.imageUrl,
          localPath: completion.localPath,
        };
      }
      if (pollResp.status === "completed" && adapter.provider === "gemini") {
        // Gemini 可能返回 base64
        const b64 = adapter.extractImageBase64(result);
        if (b64) {
          logTaskSuccess("ImageTask", "poll-base64-complete", {
            id,
            taskId,
            mimeType: b64.mimeType,
          });
          const completion = await handleImageCompleteBase64(
            id,
            config.provider,
            b64.data,
            b64.mimeType,
          );
          return {
            status: "completed" as const,
            mode: "poll_base64" as const,
            localPath: completion.localPath,
            mimeType: b64.mimeType,
          };
        }
      }
      if (pollResp.status === "failed") {
        logTaskError("ImageTask", "poll-failed", {
          id,
          taskId,
          error: pollResp.error || "Generation failed",
        });
        throw new Error(pollResp.error || "Generation failed");
      }
    } catch (err: any) {
      if (i === 119 || Date.now() - startedAt >= maxDurationMs) {
        logTaskError("ImageTask", "poll-timeout", {
          id,
          taskId,
          error: err.message,
        });
        db.update(schema.imageGenerations)
          .set({
            status: "failed",
            errorMsg: `Timeout: ${err.message}`,
            updatedAt: now(),
          })
          .where(eq(schema.imageGenerations.id, id))
          .run();
        return { status: "failed" as const, error: `Timeout: ${err.message}` };
      }
      logTaskWarn("ImageTask", "poll-retry", {
        id,
        taskId,
        attempt: i + 1,
        error: err.message,
      });
    }
  }
  return { status: "failed" as const, error: "Polling attempts exhausted" };
}

async function handleImageComplete(
  id: number,
  provider: string,
  imageUrl: string,
) {
  const localPath = await downloadFile(imageUrl, "images");
  const rows = db
    .select()
    .from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, id))
    .all();
  const record = rows[0];

  db.update(schema.imageGenerations)
    .set({ imageUrl, localPath, status: "completed", updatedAt: now() })
    .where(eq(schema.imageGenerations.id, id))
    .run();
  logTaskSuccess("ImageTask", "downloaded", { id, provider, localPath });

  // 更新关联表
  if (record?.storyboardId) {
    const sbUpdate: Record<string, any> = { updatedAt: now() };
    if (record.frameType === "first_frame")
      sbUpdate.firstFrameImage = localPath;
    else if (record.frameType === "last_frame")
      sbUpdate.lastFrameImage = localPath;
    else sbUpdate.composedImage = localPath;
    db.update(schema.storyboards)
      .set(sbUpdate)
      .where(eq(schema.storyboards.id, record.storyboardId))
      .run();
  }
  if (record?.characterId) {
    db.update(schema.characters)
      .set({ imageUrl: localPath, updatedAt: now() })
      .where(eq(schema.characters.id, record.characterId))
      .run();
  }
  if (record?.sceneId) {
    db.update(schema.scenes)
      .set({ imageUrl: localPath, status: "completed", updatedAt: now() })
      .where(eq(schema.scenes.id, record.sceneId))
      .run();
  }
  return { imageUrl, localPath };
}

async function handleImageCompleteBase64(
  id: number,
  provider: string,
  base64Data: string,
  mimeType: string,
) {
  const localPath = await saveBase64Image(base64Data, mimeType, "images");
  const rows = db
    .select()
    .from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, id))
    .all();
  const record = rows[0];

  db.update(schema.imageGenerations)
    .set({ localPath, status: "completed", updatedAt: now() })
    .where(eq(schema.imageGenerations.id, id))
    .run();
  logTaskSuccess("ImageTask", "saved-base64", {
    id,
    provider,
    mimeType,
    localPath,
  });

  // 更新关联表
  if (record?.storyboardId) {
    const sbUpdate: Record<string, any> = { updatedAt: now() };
    if (record.frameType === "first_frame")
      sbUpdate.firstFrameImage = localPath;
    else if (record.frameType === "last_frame")
      sbUpdate.lastFrameImage = localPath;
    else sbUpdate.composedImage = localPath;
    db.update(schema.storyboards)
      .set(sbUpdate)
      .where(eq(schema.storyboards.id, record.storyboardId))
      .run();
  }
  if (record?.characterId) {
    db.update(schema.characters)
      .set({ imageUrl: localPath, updatedAt: now() })
      .where(eq(schema.characters.id, record.characterId))
      .run();
  }
  if (record?.sceneId) {
    db.update(schema.scenes)
      .set({ imageUrl: localPath, status: "completed", updatedAt: now() })
      .where(eq(schema.scenes.id, record.sceneId))
      .run();
  }
  return { localPath };
}
