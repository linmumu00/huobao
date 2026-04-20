/**
 * Chat Orchestrator 路由 — 使用 chat_orchestrator agent 自动编排执行
 */
import { Hono } from "hono";
import { createAgent } from "../agents/index.js";
import { db, schema } from "../db/index.js";
import { success, badRequest, now } from "../utils/response.js";
import {
  logTaskError,
  logTaskPayload,
  logTaskProgress,
  logTaskStart,
  logTaskSuccess,
} from "../utils/task-logger.js";
import { eq, and, desc } from "drizzle-orm";
import {
  requestTraceMeta,
  withLangSmithRootRun,
} from "../observability/langsmith.js";

const app = new Hono();

function normalizeToolName(entry: any) {
  return (
    entry?.toolName ||
    entry?.tool?.toolName ||
    entry?.tool?.id ||
    entry?.name ||
    entry?.type ||
    null
  );
}

function normalizeToolResult(entry: any) {
  const result = entry?.result ?? entry?.output ?? entry?.data ?? null;
  return typeof result === "string" ? result : JSON.stringify(result);
}

// POST /chat — 统一对话入口（由后端 orchestrator 决策并执行）
app.post("/", async (c) => {
  const body = await c.req.json();
  const { message, drama_id, episode_id } = body || {};
  const wantsStream =
    c.req.query("stream") === "1" ||
    (c.req.header("accept") || "").includes("text/event-stream");

  logTaskStart("Chat", "chat", { dramaId: drama_id, episodeId: episode_id });
  logTaskPayload("Chat", "input", { message, drama_id, episode_id });

  if (!episode_id || !drama_id) {
    logTaskError("Chat", "chat", { reason: "missing drama_id or episode_id" });
    return badRequest(c, "drama_id and episode_id are required");
  }
  if (!message || !String(message).trim()) {
    return badRequest(c, "message is required");
  }

  // 保存 user 消息
  try {
    db.insert(schema.chatMessages)
      .values({
        dramaId: Number(drama_id),
        episodeId: Number(episode_id),
        role: "user",
        content: String(message),
        createdAt: now(),
      })
      .run();
  } catch (e) {
    // 不影响主流程
  }

  const agentType = "chat_orchestrator";
  const agent = createAgent(agentType, Number(episode_id), Number(drama_id));
  if (!agent) return badRequest(c, "Chat agent not found");

  const startTime = performance.now();
  try {
    if (wantsStream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start: async (controller) => {
          const send = (event: string, data: unknown) => {
            controller.enqueue(
              encoder.encode(
                `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
              ),
            );
          };
          try {
            send("start", {
              drama_id: Number(drama_id),
              episode_id: Number(episode_id),
            });
            await withLangSmithRootRun(
              {
                name: "chat:orchestrator",
                runType: "chain",
                inputs: { message, drama_id, episode_id },
                tags: ["route:chat", "agent:chat_orchestrator"],
                metadata: requestTraceMeta(c),
              },
              async (run) => {
                const historyRows = db
                  .select()
                  .from(schema.chatMessages)
                  .where(
                    and(
                      eq(schema.chatMessages.dramaId, Number(drama_id)),
                      eq(schema.chatMessages.episodeId, Number(episode_id)),
                    ),
                  )
                  .orderBy(desc(schema.chatMessages.id))
                  .limit(20)
                  .all()
                  .reverse();
                const historyMessages = historyRows
                  .slice(-3)
                  .map((row) => ({
                    role: (row.role === "assistant" || row.role === "system"
                      ? row.role
                      : "user") as "user" | "assistant" | "system",
                    content: String(row.content || ""),
                  }))
                  .filter((m) => m.content.trim());
                const result = await agent.generate(historyMessages, {
                  maxSteps: 30,
                  onEvent: async (event) => {
                    if (event.type === "tool_call") {
                      send("tool_call", {
                        step: event.step,
                        toolName: event.toolName,
                        args: event.args,
                      });
                    } else if (event.type === "tool_result") {
                      send("tool_result", {
                        step: event.step,
                        toolName: event.toolName,
                        result:
                          event.error != null
                            ? `ERROR: ${event.error}`
                            : typeof event.result === "string"
                              ? event.result
                              : JSON.stringify(event.result),
                        error: event.error,
                      });
                    } else if (event.type === "final_text") {
                      const fullText = String(event.text || "");
                      const chunkSize = 48;
                      for (let i = 0; i < fullText.length; i += chunkSize) {
                        send("text_delta", {
                          delta: fullText.slice(i, i + chunkSize),
                        });
                      }
                      send("text", { text: fullText });
                    }
                  },
                });
                const elapsed = ((performance.now() - startTime) / 1000).toFixed(
                  1,
                );
                logTaskSuccess("Chat", "chat", { elapsedSeconds: elapsed });

                const toolCalls = result.toolCalls || [];
                const toolResults = result.toolResults || [];
                const normalizedToolCalls = toolCalls.map((tc: any) => ({
                  toolName: normalizeToolName(tc),
                  args: tc?.args ?? tc?.input ?? null,
                }));
                const normalizedToolResults = toolResults.map((tr: any) => ({
                  toolName: normalizeToolName(tr),
                  result: normalizeToolResult(tr),
                }));

                logTaskProgress("Chat", "tool-summary", {
                  toolCalls: normalizedToolCalls.map((x: any) => x.toolName),
                  toolResults: normalizedToolResults.map((x: any) => x.toolName),
                });

                const payload = {
                  type: "done",
                  text: result.text || "",
                  toolCalls: normalizedToolCalls,
                  toolResults: normalizedToolResults,
                };

                try {
                  db.insert(schema.chatMessages)
                    .values({
                      dramaId: Number(drama_id),
                      episodeId: Number(episode_id),
                      role: "assistant",
                      content: payload.text || "",
                      toolCalls: JSON.stringify(payload.toolCalls || []),
                      toolResults: JSON.stringify(payload.toolResults || []),
                      createdAt: now(),
                    })
                    .run();
                } catch (e) {}

                if (run) {
                  try {
                    await run.end({
                      text: payload.text,
                      toolCalls: payload.toolCalls
                        ?.map((x: any) => x.toolName)
                        .filter(Boolean),
                      toolResults: payload.toolResults
                        ?.map((x: any) => x.toolName)
                        .filter(Boolean),
                      elapsedSeconds: elapsed,
                    });
                    await run.patchRun();
                  } catch {}
                }

                send("done", payload);
              },
            );
            controller.close();
          } catch (err: any) {
            send("error", {
              message: err?.message || "Chat execution failed",
            });
            controller.close();
          }
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        },
      });
    }

    return await withLangSmithRootRun(
      {
        name: "chat:orchestrator",
        runType: "chain",
        inputs: { message, drama_id, episode_id },
        tags: ["route:chat", "agent:chat_orchestrator"],
        metadata: requestTraceMeta(c),
      },
      async (run) => {
        const historyRows = db
          .select()
          .from(schema.chatMessages)
          .where(
            and(
              eq(schema.chatMessages.dramaId, Number(drama_id)),
              eq(schema.chatMessages.episodeId, Number(episode_id)),
            ),
          )
          .orderBy(desc(schema.chatMessages.id))
          .limit(20)
          .all()
          .reverse();
        const historyMessages = historyRows
          .slice(-3)
          .map((row) => ({
            role: (row.role === "assistant" || row.role === "system"
              ? row.role
              : "user") as "user" | "assistant" | "system",
            content: String(row.content || ""),
          }))
          .filter((m) => m.content.trim());
        const result = await agent.generate(historyMessages, { maxSteps: 30 });
        const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
        logTaskSuccess("Chat", "chat", { elapsedSeconds: elapsed });

        const toolCalls = result.toolCalls || [];
        const toolResults = result.toolResults || [];
        const normalizedToolCalls = toolCalls.map((tc: any) => ({
          toolName: normalizeToolName(tc),
          args: tc?.args ?? tc?.input ?? null,
        }));
        const normalizedToolResults = toolResults.map((tr: any) => ({
          toolName: normalizeToolName(tr),
          result: normalizeToolResult(tr),
        }));

        logTaskProgress("Chat", "tool-summary", {
          toolCalls: normalizedToolCalls.map((x: any) => x.toolName),
          toolResults: normalizedToolResults.map((x: any) => x.toolName),
        });

        const payload = {
          type: "done",
          text: result.text || "",
          toolCalls: normalizedToolCalls,
          toolResults: normalizedToolResults,
        };

        // 保存 assistant 消息（含工具追踪）
        try {
          db.insert(schema.chatMessages)
            .values({
              dramaId: Number(drama_id),
              episodeId: Number(episode_id),
              role: "assistant",
              content: payload.text || "",
              toolCalls: JSON.stringify(payload.toolCalls || []),
              toolResults: JSON.stringify(payload.toolResults || []),
              createdAt: now(),
            })
            .run();
        } catch (e) {
          // 不影响主流程
        }

        if (run) {
          try {
            await run.end({
              text: payload.text,
              toolCalls: payload.toolCalls
                ?.map((x: any) => x.toolName)
                .filter(Boolean),
              toolResults: payload.toolResults
                ?.map((x: any) => x.toolName)
                .filter(Boolean),
              elapsedSeconds: elapsed,
            });
            await run.patchRun();
          } catch {}
        }

        return success(c, payload);
      },
    );
  } catch (err: any) {
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
    logTaskError("Chat", "chat", {
      elapsedSeconds: elapsed,
      error: err.message,
    });
    console.error(err.stack || err);
    return badRequest(c, err.message || "Chat execution failed");
  }
});

// GET /chat/messages?drama_id=1&episode_id=2&limit=100
app.get("/messages", async (c) => {
  const dramaId = Number(c.req.query("drama_id") || 0);
  const episodeId = Number(c.req.query("episode_id") || 0);
  const limit = Math.min(Number(c.req.query("limit") || 100), 500);
  if (!dramaId || !episodeId)
    return badRequest(c, "drama_id and episode_id are required");

  const rows = db
    .select()
    .from(schema.chatMessages)
    .where(
      and(
        eq(schema.chatMessages.dramaId, dramaId),
        eq(schema.chatMessages.episodeId, episodeId),
      ),
    )
    .orderBy(desc(schema.chatMessages.id))
    .limit(limit)
    .all();

  // 返回按时间正序
  return success(c, rows.reverse());
});

export default app;
