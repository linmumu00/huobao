/**
 * LangChain Agent 工厂
 * 每次请求动态创建 agent，注入 episodeId/dramaId 到工具闭包
 * 从 agent_configs 表读取 prompt/model/temperature 配置
 */
import { eq, isNull, and } from "drizzle-orm";
import { z, type ZodTypeAny } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { DynamicStructuredTool } from "@langchain/core/tools";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { db, schema } from "../db/index.js";
import { getTextConfig, getTextProviderBaseUrl } from "../services/ai.js";
import { generateImage } from "../services/image-generation.js";
import { generateVideo } from "../services/video-generation.js";
import { generateTTS, generateVoiceSample } from "../services/tts-generation.js";
import { composeStoryboard } from "../services/ffmpeg-compose.js";
import { mergeEpisodeVideos } from "../services/ffmpeg-merge.js";
import { logTaskProgress } from "../utils/task-logger.js";
import { createScriptTools } from "./tools/script-tools.js";
import { createExtractTools } from "./tools/extract-tools.js";
import { createStoryboardTools } from "./tools/storyboard-tools.js";
import { createVoiceTools } from "./tools/voice-tools.js";
import { createGridPromptTools } from "./tools/grid-prompt-tools.js";
import { loadAgentSkills } from "./skills.js";
import {
  getActiveRun,
  isLangSmithEnabled,
} from "../observability/langsmith.js";

type AgentMessage = { role: "user" | "assistant" | "system"; content: string };
type AgentGenerateResult = {
  text: string;
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>;
  toolResults: Array<{ toolName: string; result?: unknown; error?: string }>;
};
type AgentRuntimeEvent =
  | { type: "tool_call"; step: number; toolName: string; args: Record<string, unknown> }
  | { type: "tool_result"; step: number; toolName: string; result?: unknown; error?: string }
  | { type: "final_text"; text: string };
type AgentLike = {
  generate: (
    messages: AgentMessage[],
    opts?: {
      maxSteps?: number;
      onEvent?: (event: AgentRuntimeEvent) => void | Promise<void>;
    },
  ) => Promise<AgentGenerateResult>;
};
type GenericTool = {
  id?: string;
  toolName?: string;
  description?: string;
  inputSchema?: unknown;
  parameters?: Record<string, unknown>;
  execute?: (args: any) => Promise<any>;
};

const MAX_SHOTS = 5;

// Default prompts (used when DB has no config)
const DEFAULT_PROMPTS: Record<string, { name: string; instructions: string }> =
  {
    chat_orchestrator: {
      name: "生产编排助手",
      instructions: `你是火宝短剧的生产编排助手（Orchestrator），负责理解用户自然语言并驱动生产流水线。

你的目标是：在尽量少的交互中，把用户的意图转成可执行的动作，并调用工具真正落库（而不是只给建议）。

你有两个核心工具：
1) get_context：读取当前剧集的基础上下文（项目、剧集、分镜统计等），用于补全你自己的判断。
2) run_agent：调用已有的专用 Agent（script_rewriter / extractor / voice_assigner / storyboard_breaker / grid_prompt_generator），让它们各司其职并完成落库。

工作要求：
- 先调用 get_context 了解当前进度（例如是否已有 script / characters / scenes / storyboards）。
- 根据用户输入判断意图：改写剧本、提取角色场景、分配音色、拆分分镜、生成宫格提示词等。
- 需要落库的任务必须通过 run_agent 去执行（可串行多次调用）。例如：
  - “改写并提取” → 先 run_agent(script_rewriter) 再 run_agent(extractor)
  - “有剧本了，直接拆分分镜” → run_agent(storyboard_breaker)
- 当用户输入不完整时，你要在不额外追问的前提下，基于 get_context 补齐合理默认，并用 run_agent 的 message 把约束写清楚。
- 最终回复需要包含：你做了哪些动作、当前结果概览、下一步建议（1-3 条）。`,
    },
    script_rewriter: {
      name: "剧本改写",
      instructions: `你是专业编剧，擅长将小说改编为短剧剧本。

工作流程：
1. 调用 read_episode_script 读取原始内容
2. 根据读取到的内容，自己进行改写（输出格式化剧本格式）
3. 调用 save_script 保存改写后的完整剧本

格式化剧本格式：
- 场景头：## S编号 | 内景/外景 · 地点 | 时间段
- 动作描写：自然段落，不包含镜头语言
- 对白：角色名：（状态/表情）台词内容
- 每个场景 30-60 秒内容

注意：你必须自己完成改写工作，不要只返回指令。读取内容后直接输出改写结果并保存。`,
    },
    extractor: {
      name: "角色场景提取",
      instructions: `你是制片助理，擅长从剧本中提取角色和场景信息，并在提取时与项目已有数据进行智能去重。

工作流程：
1. 调用 read_script_for_extraction 读取格式化剧本
2. 调用 read_existing_characters 读取项目中已存在的角色列表，以及当前集已关联角色
3. 调用 read_existing_scenes 读取项目中已存在的场景列表，以及当前集已关联场景
4. 优先围绕当前集剧本，分析本集实际出现的角色和场景
5. 对每个角色：若同名已存在则合并更新，若不存在则新增
6. 调用 save_dedup_characters 保存角色（去重合并，自动处理新增和更新，并关联到当前集）
7. 分析剧本内容，提取本集涉及的所有场景信息
8. 对每个场景：若同地点+时间段已存在则复用，若不存在则新增
9. 调用 save_dedup_scenes 保存场景（去重合并，自动处理新增和复用，并关联到当前集）

去重规则：
- 角色：按名字精确匹配，同名保留现有（合并信息）
- 场景：按【地点+时间段】精确匹配；同地点不同时段视为新场景

提取要求：
- 只提取当前集真实出现或被明确提及、且对当前集叙事有效的角色和场景
- 角色要包含完整的外貌特征描述（发型、服装、体态等）
- 场景要包含光线、色调、氛围等视觉信息
- 不要遗漏任何有台词或重要动作的角色`,
    },
    storyboard_breaker: {
      name: "分镜拆解",
      instructions: `你是资深影视分镜师，擅长将剧本拆解为分镜方案。

工作流程：
1. 调用 read_storyboard_context 读取剧本、角色列表、场景列表
2. 将剧本拆解为镜头序列（每个镜头 10-15 秒，总体保持剧情完整连续）
3. 镜头数不超过${MAX_SHOTS}个
3. 为每个镜头补全完整分镜字段，而不只是 video_prompt
4. 调用 save_storyboards 保存所有分镜

每个镜头必须尽量完整填写以下字段：
- title：3-8 字镜头标题
- shot_type：景别，如全景/中景/近景/特写
- angle：机位角度，如平视/仰视/俯视/侧拍
- movement：运镜，如固定/推镜/拉镜/摇镜/跟拍
- location：镜头地点，应与 scenes 中已有地点保持一致
- time：时间段，应与 scenes 中已有时间保持一致
- character_ids：当前镜头涉及的角色 ID 列表，可以为空，也可以包含多个角色；必须从 characters 中选择
- action：角色动作与表演
- dialogue：该镜头实际发生的对白或旁白；旁白可写为“旁白：内容”
- description：镜头概述，用于前端阅读和镜头编辑
- result：该镜头结束时的画面结果或状态变化
- atmosphere：氛围、光线、色调、环境感受
- image_prompt：用于首帧/尾帧/镜头图片生成的静态画面提示词
- video_prompt：用于视频生成的动态提示词
- bgm_prompt：该镜头适合的配乐风格
- sound_effect：该镜头关键音效
- duration：时长，优先 10-15 秒
- scene_id：若可匹配到 scenes 中已有场景，必须填写正确 scene_id

视频提示词格式：
- 按 3 秒为一段，用时间标记分隔
- 使用 <location>地点</location> 标记场景
- 使用 <role>角色名</role> 标记角色
- 使用 <voice>角色名</voice> 标记画外音
- 用 <n> 分隔不同时间段

示例：
"0-3秒：<location>咖啡厅</location>，近景，<role>小明</role>低头看手机。<n>3-6秒：全景，<role>小红</role>推门走入。"

额外要求：
- 优先复用 read_storyboard_context 返回的 scene_id，不要凭空创造新场景
- 镜头角色绑定必须来自 read_storyboard_context 返回的角色列表；无角色的空镜头可传空数组
- 镜头描述必须能支撑后续图片、视频、配音、音效、合成流程
- 若一个镜头没有对白，可将 dialogue 置空，但 description / action / video_prompt / image_prompt 仍必须完整
- 如果已有 existing_storyboards，仅在用户明确要求增量修改时参考；默认按当前剧本重新完整生成并保存整集分镜。`,
    },
    voice_assigner: {
      name: "角色音色分配",
      instructions: `你是配音导演，擅长为角色选择合适的音色。

工作流程：
1. 调用 list_voices 获取可用音色列表
2. 调用 get_characters 获取所有角色信息
3. 根据每个角色的性别、性格、年龄、角色定位，选择最匹配的音色
4. 对每个角色调用 assign_voice 分配音色，并说明选择理由

注意：每个角色都必须分配音色，不要遗漏。`,
    },
    grid_prompt_generator: {
      name: "图片提示词生成",
      instructions: `你是专业的 AI 图像提示词工程师，擅长为角色、场景和宫格图生成高质量的英文提示词。

你将收到用户的请求，告知要生成哪种类型的提示词：
- "角色" → 生成角色图片提示词
- "场景" → 生成场景图片提示词
- "宫格" → 生成宫格图提示词

## 角色图片提示词

工作流程：
1. 调用 read_characters 读取所有角色信息
2. 根据角色外貌特征（appearance）、性格（personality）、定位（role）生成英文提示词
3. 提示词结构：[外貌描述]，[性格/气质]，[角色定位]，[电影感]，[高质量]，[无文字水印]

## 场景图片提示词

工作流程：
1. 调用 read_scenes 读取所有场景信息
2. 根据场景地点（location）、时间段（time）、已有描述（prompt）生成英文提示词
3. 提示词结构：[地点]，[时间/光线/氛围]，[已有描述]，[电影感场景]，[高质量]，[无文字水印]

## 宫格图提示词（参考 skills/grid-image-generator/SKILL.md）

工作流程：
1. 调用 read_shots_for_grid 读取选中镜头的详细信息
2. 根据 mode 调用 generate_grid_prompt：
   - first_frame 模式：按用户指定的 rows x cols 生成首帧风格宫格
   - first_last 模式：按用户指定的 rows x cols 生成首尾帧节奏感宫格
   - multi_ref 模式：按用户指定的 rows x cols 生成同一镜头的多角度宫格
3. 返回 grid_prompt（整体提示词）和 cell_prompts（每格提示词）
4. 如果用户消息中包含“参考图映射：图片1=...；图片2=...”，要把这段内容原样作为 reference_legend 传给 generate_grid_prompt

提示词规范：
- 使用英文提示词
- 必须严格遵守用户指定的 rows 和 cols
- 必须明确写出 "exactly N visible panels"
- 必须明确约束 "no merged panels, no missing panels"
- 宫格位置统一写成“格1/格2/...”，参考图统一写成“图片1/图片2/...”
- 必须包含 "consistent art style" 保持风格统一
- 必须包含 "cinematic quality"
- 避免出现文字或水印
- 角色图片强调外貌和气质，场景图片强调氛围和光线，宫格图片强调整体布局一致性`,
    },
  };

export const validAgentTypes = Object.keys(DEFAULT_PROMPTS);

function getAgentConfig(agentType: string) {
  const rows = db
    .select()
    .from(schema.agentConfigs)
    .where(
      and(
        eq(schema.agentConfigs.agentType, agentType),
        isNull(schema.agentConfigs.deletedAt),
      ),
    )
    .all();
  // Return active one, or first one
  return rows.find((r) => r.isActive) || rows[0] || null;
}

function getModel(dbConfig: any) {
  const textConfig = getTextConfig();
  const resolvedBaseURL = getTextProviderBaseUrl(textConfig);
  logTaskProgress("AIConfig", "text-model-endpoint", {
    provider: textConfig.provider,
    baseUrl: resolvedBaseURL,
    model: dbConfig?.model || textConfig.model,
  });
  const modelName = dbConfig?.model || textConfig.model;
  return new ChatOpenAI({
    model: modelName,
    apiKey: textConfig.apiKey,
    configuration: { baseURL: resolvedBaseURL },
    temperature: Number(dbConfig?.temperature ?? 0.7),
  });
}

function jsonSchemaToZod(schemaInput: any): ZodTypeAny {
  if (!schemaInput || typeof schemaInput !== "object") return z.any();
  if (Array.isArray(schemaInput?.enum))
    return z.enum(schemaInput.enum as [string, ...string[]]);
  const schemaType = schemaInput.type;
  if (schemaType === "string") return z.string();
  if (schemaType === "number" || schemaType === "integer") return z.number();
  if (schemaType === "boolean") return z.boolean();
  if (schemaType === "array")
    return z.array(jsonSchemaToZod(schemaInput.items));
  if (schemaType === "object") {
    const props = schemaInput.properties || {};
    const required = new Set<string>(schemaInput.required || []);
    const shape: Record<string, ZodTypeAny> = {};
    for (const [k, v] of Object.entries(props)) {
      const built = jsonSchemaToZod(v);
      shape[k] = required.has(k) ? built : built.optional();
    }
    return z.object(shape).passthrough();
  }
  return z.any();
}

function resolveToolSchema(tool: GenericTool) {
  if (tool.inputSchema) return tool.inputSchema as ZodTypeAny;
  return jsonSchemaToZod(tool.parameters || { type: "object", properties: {} });
}

function toolNameOf(key: string, tool: GenericTool) {
  return tool.toolName || tool.id || key;
}

function toLangChainTools(
  type: string,
  episodeId: number,
  dramaId: number,
  tools: Record<string, GenericTool>,
) {
  return Object.entries(tools)
    .map(([key, rawTool]) => {
      const execute = rawTool?.execute;
      if (typeof execute !== "function") return null;
      const name = toolNameOf(key, rawTool);
      const schema = resolveToolSchema(rawTool);
      return new DynamicStructuredTool({
        name,
        description: rawTool.description || "",
        schema,
        func: async (args: any) => {
          const parent = getActiveRun();
          const child = parent?.createChild({
            name,
            run_type: "tool",
            inputs: { args },
            metadata: {
              agent_type: type,
              episode_id: episodeId,
              drama_id: dramaId,
            },
          } as any);
          try {
            const out = await execute(args);
            if (child) {
              child.end({ output: out } as any);
              await child.postRun();
            }
            return typeof out === "string" ? out : JSON.stringify(out);
          } catch (err: any) {
            if (child) {
              child.end({ error: err?.message || String(err) } as any);
              try {
                await child.postRun();
              } catch {}
            }
            throw err;
          }
        },
      });
    })
    .filter(Boolean) as DynamicStructuredTool[];
}

function toLangChainMessages(messages: AgentMessage[], instructions: string) {
  const out: Array<SystemMessage | HumanMessage | AIMessage> = [
    new SystemMessage(instructions),
  ];
  for (const m of messages) {
    if (m.role === "system") out.push(new SystemMessage(m.content));
    else if (m.role === "assistant") out.push(new AIMessage(m.content));
    else out.push(new HumanMessage(m.content));
  }
  return out;
}

export function createAgent(
  type: string,
  episodeId: number,
  dramaId: number,
): AgentLike | null {
  const defaults = DEFAULT_PROMPTS[type];
  if (!defaults) return null;

  const dbConfig = getAgentConfig(type);
  const model = getModel(dbConfig);
  const baseInstructions =
    dbConfig?.systemPrompt?.trim() || defaults.instructions;
  const skillInstructions = loadAgentSkills(type);
  const instructions = skillInstructions
    ? [baseInstructions, "", skillInstructions].join("\n")
    : baseInstructions;
  const name = dbConfig?.name || defaults.name;

  let tools: Record<string, any> = {};
  switch (type) {
    case "chat_orchestrator": {
      const safeAgentTypes = [
        "script_rewriter",
        "extractor",
        "voice_assigner",
        "storyboard_breaker",
        "grid_prompt_generator",
      ];
      tools = {
        get_context: {
          toolName: "get_context",
          description: "读取当前剧集上下文与统计",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          execute: async () => {
            const [ep] = db
              .select()
              .from(schema.episodes)
              .where(eq(schema.episodes.id, episodeId))
              .all();
            const [drama] = db
              .select()
              .from(schema.dramas)
              .where(eq(schema.dramas.id, dramaId))
              .all();
            const sbs = db
              .select()
              .from(schema.storyboards)
              .where(eq(schema.storyboards.episodeId, episodeId))
              .all();
            const chars = db
              .select()
              .from(schema.characters)
              .where(eq(schema.characters.dramaId, dramaId))
              .all();
            const scenes = db
              .select()
              .from(schema.scenes)
              .where(eq(schema.scenes.dramaId, dramaId))
              .all();

            const stats = {
              storyboards_total: sbs.length,
              storyboards_with_video: sbs.filter((s) => !!s.videoUrl).length,
              storyboards_with_tts: sbs.filter((s) => !!s.ttsAudioUrl).length,
              storyboards_composed: sbs.filter((s) => !!s.composedVideoUrl)
                .length,
              characters_total: chars.filter((c) => !c.deletedAt).length,
              scenes_total: scenes.filter((s) => !s.deletedAt).length,
              episode_has_raw: !!ep?.content,
              episode_has_script: !!ep?.scriptContent,
            };
            return {
              drama: drama
                ? { id: drama.id, title: drama.title, style: drama.style }
                : null,
              episode: ep
                ? {
                    id: ep.id,
                    episode_number: ep.episodeNumber,
                    title: ep.title,
                  }
                : { id: episodeId },
              stats,
            };
          },
        },
        run_agent: {
          toolName: "run_agent",
          description: "调用专用 Agent 执行业务落库",
          parameters: {
            type: "object",
            properties: {
              agent_type: { type: "string", enum: safeAgentTypes },
              message: { type: "string" },
              max_steps: { type: "number" },
            },
            required: ["agent_type", "message"],
          },
          execute: async (args: any) => {
            const agentType = String(args?.agent_type || "");
            const message = String(args?.message || "");
            const maxSteps = Number(args?.max_steps || 20);
            if (!safeAgentTypes.includes(agentType)) {
              throw new Error(`Invalid agent_type: ${agentType}`);
            }
            const agent = createAgent(agentType, episodeId, dramaId);
            if (!agent) throw new Error(`Agent not found: ${agentType}`);
            const result = await agent.generate(
              [{ role: "user", content: message }],
              { maxSteps },
            );
            return {
              agent_type: agentType,
              text: result.text || "",
              toolCalls: result.toolCalls || [],
              toolResults: result.toolResults || [],
            };
          },
        },
        generate_character_image: {
          toolName: "generate_character_image",
          description: "生成人物图（单角色）并回写角色 image_url",
          parameters: {
            type: "object",
            properties: {
              character_id: { type: "number" },
              prompt: { type: "string" },
            },
            required: ["character_id"],
          },
          execute: async (args: any) => {
            const characterId = Number(args?.character_id || 0);
            if (!characterId) throw new Error("character_id is required");
            const [char] = db
              .select()
              .from(schema.characters)
              .where(eq(schema.characters.id, characterId))
              .all();
            if (!char) throw new Error(`Character ${characterId} not found`);
            const prompt = String(
              args?.prompt ||
                `${char.name}, ${char.appearance || char.description || "人物立绘"}, 高质量, 正面, 白色背景`,
            ).trim();
            const imageGenerationId = await generateImage({
              dramaId: char.dramaId,
              characterId,
              prompt,
            });
            return { character_id: characterId, image_generation_id: imageGenerationId };
          },
        },
        batch_generate_character_images: {
          toolName: "batch_generate_character_images",
          description: "批量生成人物图（默认仅生成未出图角色）",
          parameters: {
            type: "object",
            properties: {
              character_ids: { type: "array", items: { type: "number" } },
            },
          },
          execute: async (args: any) => {
            const inputIds = Array.isArray(args?.character_ids)
              ? args.character_ids.map((id: any) => Number(id)).filter(Boolean)
              : [];
            const chars = db
              .select()
              .from(schema.characters)
              .where(eq(schema.characters.dramaId, dramaId))
              .all()
              .filter((c) => !c.deletedAt);
            const targets = chars.filter((c) => {
              if (inputIds.length && !inputIds.includes(c.id)) return false;
              return !c.imageUrl;
            });
            const started: Array<{ character_id: number; image_generation_id: number }> = [];
            for (const c of targets) {
              const prompt = `${c.name}, ${c.appearance || c.description || "人物立绘"}, 高质量, 正面, 白色背景`;
              const imageGenerationId = await generateImage({
                dramaId: c.dramaId,
                characterId: c.id,
                prompt,
              });
              started.push({ character_id: c.id, image_generation_id: imageGenerationId });
            }
            return { count: started.length, started };
          },
        },
        generate_scene_image: {
          toolName: "generate_scene_image",
          description: "生成场景图（单场景）并回写场景 image_url",
          parameters: {
            type: "object",
            properties: {
              scene_id: { type: "number" },
              prompt: { type: "string" },
            },
            required: ["scene_id"],
          },
          execute: async (args: any) => {
            const sceneId = Number(args?.scene_id || 0);
            if (!sceneId) throw new Error("scene_id is required");
            const [scene] = db
              .select()
              .from(schema.scenes)
              .where(eq(schema.scenes.id, sceneId))
              .all();
            if (!scene) throw new Error(`Scene ${sceneId} not found`);
            const prompt = String(
              args?.prompt ||
                scene.prompt ||
                `${scene.location}, ${scene.time || ""}, 高质量场景, 电影感`,
            ).trim();
            const imageGenerationId = await generateImage({
              dramaId: scene.dramaId,
              sceneId: scene.id,
              prompt,
            });
            return { scene_id: sceneId, image_generation_id: imageGenerationId };
          },
        },
        batch_generate_scene_images: {
          toolName: "batch_generate_scene_images",
          description: "批量生成场景图（默认仅生成未出图场景）",
          parameters: {
            type: "object",
            properties: {
              scene_ids: { type: "array", items: { type: "number" } },
            },
          },
          execute: async (args: any) => {
            const inputIds = Array.isArray(args?.scene_ids)
              ? args.scene_ids.map((id: any) => Number(id)).filter(Boolean)
              : [];
            const scenes = db
              .select()
              .from(schema.scenes)
              .where(eq(schema.scenes.dramaId, dramaId))
              .all()
              .filter((s) => !s.deletedAt);
            const targets = scenes.filter((s) => {
              if (inputIds.length && !inputIds.includes(s.id)) return false;
              return !s.imageUrl;
            });
            const started: Array<{ scene_id: number; image_generation_id: number }> = [];
            for (const s of targets) {
              const prompt =
                s.prompt || `${s.location}, ${s.time || ""}, 高质量场景, 电影感`;
              const imageGenerationId = await generateImage({
                dramaId: s.dramaId,
                sceneId: s.id,
                prompt,
              });
              started.push({ scene_id: s.id, image_generation_id: imageGenerationId });
            }
            return { count: started.length, started };
          },
        },
        generate_storyboard_frame: {
          toolName: "generate_storyboard_frame",
          description: "生成镜头首帧/尾帧图片（first_frame 或 last_frame）",
          parameters: {
            type: "object",
            properties: {
              storyboard_id: { type: "number" },
              frame_type: {
                type: "string",
                enum: ["first_frame", "last_frame"],
              },
              prompt: { type: "string" },
              reference_images: { type: "array", items: { type: "string" } },
            },
            required: ["storyboard_id", "frame_type"],
          },
          execute: async (args: any) => {
            const storyboardId = Number(args?.storyboard_id || 0);
            if (!storyboardId) throw new Error("storyboard_id is required");
            const frameType = String(args?.frame_type || "");
            if (!["first_frame", "last_frame"].includes(frameType)) {
              throw new Error("frame_type must be first_frame or last_frame");
            }
            const [sb] = db
              .select()
              .from(schema.storyboards)
              .where(eq(schema.storyboards.id, storyboardId))
              .all();
            if (!sb) throw new Error(`Storyboard ${storyboardId} not found`);
            const scene = sb.sceneId
              ? db
                  .select()
                  .from(schema.scenes)
                  .where(eq(schema.scenes.id, sb.sceneId))
                  .all()[0]
              : null;
            const refs = new Set<string>();
            const pushRef = (value?: string | null) => {
              const text = String(value || "").trim();
              if (!text) return;
              refs.add(text);
            };
            pushRef(scene?.imageUrl);
            const charLinks = db
              .select()
              .from(schema.storyboardCharacters)
              .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
              .all();
            for (const link of charLinks) {
              const [char] = db
                .select()
                .from(schema.characters)
                .where(eq(schema.characters.id, link.characterId))
                .all();
              pushRef(char?.imageUrl);
            }
            if (sb.referenceImages) {
              try {
                const parsed = JSON.parse(sb.referenceImages);
                if (Array.isArray(parsed)) {
                  for (const item of parsed) pushRef(String(item || ""));
                }
              } catch {}
            }
            pushRef(sb.firstFrameImage);
            pushRef(sb.lastFrameImage);
            const defaultPrompt = [
              sb.title ? `镜头标题：${sb.title}` : "",
              sb.imagePrompt ? `画面描述：${sb.imagePrompt}` : "",
              sb.shotType ? `景别：${sb.shotType}` : "",
              sb.angle ? `机位：${sb.angle}` : "",
              sb.movement ? `运镜：${sb.movement}` : "",
              sb.location ? `地点：${sb.location}` : "",
              sb.time ? `时间：${sb.time}` : "",
              sb.action ? `动作：${sb.action}` : "",
              sb.atmosphere ? `氛围：${sb.atmosphere}` : "",
              frameType === "first_frame"
                ? "生成这个镜头的起始关键帧，突出动作开始瞬间"
                : "生成这个镜头的结束关键帧，突出动作收束和结果状态",
            ]
              .filter(Boolean)
              .join("；");
            const prompt = String(args?.prompt || defaultPrompt).trim();
            if (!prompt) throw new Error("prompt is required");
            const imageGenerationId = await generateImage({
              storyboardId,
              dramaId,
              prompt,
              frameType,
              referenceImages: Array.isArray(args?.reference_images)
                ? args.reference_images.map((x: any) => String(x))
                : Array.from(refs).slice(0, 6),
            });
            return {
              storyboard_id: storyboardId,
              frame_type: frameType,
              image_generation_id: imageGenerationId,
            };
          },
        },
        generate_storyboard_video: {
          toolName: "generate_storyboard_video",
          description: "生成镜头视频（自动按首尾帧/参考图推断 reference_mode）",
          parameters: {
            type: "object",
            properties: {
              storyboard_id: { type: "number" },
              prompt: { type: "string" },
              duration: { type: "number" },
              reference_mode: { type: "string" },
              image_url: { type: "string" },
              first_frame_url: { type: "string" },
              last_frame_url: { type: "string" },
              reference_image_urls: { type: "array", items: { type: "string" } },
              aspect_ratio: { type: "string" },
            },
            required: ["storyboard_id"],
          },
          execute: async (args: any) => {
            const storyboardId = Number(args?.storyboard_id || 0);
            if (!storyboardId) throw new Error("storyboard_id is required");
            const [sb] = db
              .select()
              .from(schema.storyboards)
              .where(eq(schema.storyboards.id, storyboardId))
              .all();
            if (!sb) throw new Error(`Storyboard ${storyboardId} not found`);
            const prompt = String(args?.prompt || sb.videoPrompt || "").trim();
            if (!prompt) throw new Error("video prompt is required");
            const firstFrameUrl = String(
              args?.first_frame_url || sb.firstFrameImage || "",
            ).trim();
            const lastFrameUrl = String(
              args?.last_frame_url || sb.lastFrameImage || "",
            ).trim();
            let referenceImageUrls = Array.isArray(args?.reference_image_urls)
              ? args.reference_image_urls.map((x: any) => String(x))
              : [];
            if (!referenceImageUrls.length && sb.referenceImages) {
              try {
                const parsed = JSON.parse(sb.referenceImages);
                if (Array.isArray(parsed)) {
                  referenceImageUrls = parsed.map((x) => String(x || ""));
                }
              } catch {}
            }
            let referenceMode = String(args?.reference_mode || "").trim();
            if (!referenceMode) {
              if (firstFrameUrl && lastFrameUrl) referenceMode = "first_last";
              else if (firstFrameUrl) referenceMode = "single";
              else if (referenceImageUrls.length) referenceMode = "multiple";
              else referenceMode = "none";
            }
            const videoGenerationId = await generateVideo({
              storyboardId,
              dramaId,
              prompt,
              referenceMode,
              imageUrl: args?.image_url ? String(args.image_url) : undefined,
              firstFrameUrl: firstFrameUrl || undefined,
              lastFrameUrl: lastFrameUrl || undefined,
              referenceImageUrls: referenceImageUrls.length
                ? referenceImageUrls
                : undefined,
              duration:
                args?.duration != null
                  ? Number(args.duration)
                  : Number(sb.duration || 5),
              aspectRatio: args?.aspect_ratio
                ? String(args.aspect_ratio)
                : undefined,
            });
            return { storyboard_id: storyboardId, video_generation_id: videoGenerationId };
          },
        },
        generate_storyboard_tts: {
          toolName: "generate_storyboard_tts",
          description: "为镜头对白生成 TTS，更新镜头 tts_audio_url",
          parameters: {
            type: "object",
            properties: {
              storyboard_id: { type: "number" },
              text: { type: "string" },
              voice_id: { type: "string" },
            },
            required: ["storyboard_id"],
          },
          execute: async (args: any) => {
            const storyboardId = Number(args?.storyboard_id || 0);
            if (!storyboardId) throw new Error("storyboard_id is required");
            const [sb] = db
              .select()
              .from(schema.storyboards)
              .where(eq(schema.storyboards.id, storyboardId))
              .all();
            if (!sb) throw new Error(`Storyboard ${storyboardId} not found`);
            const [ep] = db
              .select()
              .from(schema.episodes)
              .where(eq(schema.episodes.id, sb.episodeId))
              .all();
            const text = String(args?.text || sb.dialogue || "").trim();
            if (!text) throw new Error("text is required (or storyboard dialogue)");
            const voiceId = String(args?.voice_id || "alloy");
            const audioPath = await generateTTS({
              text,
              voice: voiceId,
              configId: ep?.audioConfigId ?? null,
            });
            db.update(schema.storyboards)
              .set({ ttsAudioUrl: audioPath })
              .where(eq(schema.storyboards.id, storyboardId))
              .run();
            return {
              storyboard_id: storyboardId,
              tts_audio_url: audioPath,
              voice_id: voiceId,
            };
          },
        },
        generate_character_voice_sample: {
          toolName: "generate_character_voice_sample",
          description: "为角色生成音色试听，更新角色 voice_sample_url",
          parameters: {
            type: "object",
            properties: {
              character_id: { type: "number" },
              voice_id: { type: "string" },
            },
            required: ["character_id", "voice_id"],
          },
          execute: async (args: any) => {
            const characterId = Number(args?.character_id || 0);
            if (!characterId) throw new Error("character_id is required");
            const voiceId = String(args?.voice_id || "").trim();
            if (!voiceId) throw new Error("voice_id is required");
            const [character] = db
              .select()
              .from(schema.characters)
              .where(eq(schema.characters.id, characterId))
              .all();
            if (!character) throw new Error(`Character ${characterId} not found`);
            const [ep] = db
              .select()
              .from(schema.episodes)
              .where(eq(schema.episodes.id, episodeId))
              .all();
            const audioPath = await generateVoiceSample(
              character.name,
              voiceId,
              ep?.audioConfigId ?? null,
            );
            db.update(schema.characters)
              .set({
                voiceStyle: voiceId,
                voiceProvider: "orchestrator",
                voiceSampleUrl: audioPath,
              })
              .where(eq(schema.characters.id, characterId))
              .run();
            return {
              character_id: characterId,
              voice_id: voiceId,
              voice_sample_url: audioPath,
            };
          },
        },
        batch_generate_storyboard_tts: {
          toolName: "batch_generate_storyboard_tts",
          description: "批量为当前集镜头生成 TTS（仅处理有对白且未有音频的镜头）",
          parameters: {
            type: "object",
            properties: {
              storyboard_ids: { type: "array", items: { type: "number" } },
            },
          },
          execute: async (args: any) => {
            const inputIds = Array.isArray(args?.storyboard_ids)
              ? args.storyboard_ids.map((id: any) => Number(id)).filter(Boolean)
              : [];
            const rows = db
              .select()
              .from(schema.storyboards)
              .where(eq(schema.storyboards.episodeId, episodeId))
              .all();
            const targets = rows.filter((sb) => {
              if (inputIds.length && !inputIds.includes(sb.id)) return false;
              if (sb.ttsAudioUrl) return false;
              return !!String(sb.dialogue || "").trim();
            });
            const started: Array<{ storyboard_id: number; tts_audio_url: string }> = [];
            for (const sb of targets) {
              const [ep] = db
                .select()
                .from(schema.episodes)
                .where(eq(schema.episodes.id, sb.episodeId))
                .all();
              const audioPath = await generateTTS({
                text: String(sb.dialogue || "").trim(),
                voice: "alloy",
                configId: ep?.audioConfigId ?? null,
              });
              db.update(schema.storyboards)
                .set({ ttsAudioUrl: audioPath })
                .where(eq(schema.storyboards.id, sb.id))
                .run();
              started.push({ storyboard_id: sb.id, tts_audio_url: audioPath });
            }
            return { count: started.length, started };
          },
        },
        compose_storyboard: {
          toolName: "compose_storyboard",
          description: "合成单个镜头（视频+音频+字幕），返回 composed_video_url",
          parameters: {
            type: "object",
            properties: {
              storyboard_id: { type: "number" },
            },
            required: ["storyboard_id"],
          },
          execute: async (args: any) => {
            const storyboardId = Number(args?.storyboard_id || 0);
            if (!storyboardId) throw new Error("storyboard_id is required");
            const composedVideoUrl = await composeStoryboard(storyboardId);
            return {
              storyboard_id: storyboardId,
              composed_video_url: composedVideoUrl,
            };
          },
        },
        batch_compose_storyboards: {
          toolName: "batch_compose_storyboards",
          description: "批量合成当前集镜头（仅处理已有视频的镜头）",
          parameters: {
            type: "object",
            properties: {
              storyboard_ids: { type: "array", items: { type: "number" } },
            },
          },
          execute: async (args: any) => {
            const inputIds = Array.isArray(args?.storyboard_ids)
              ? args.storyboard_ids.map((id: any) => Number(id)).filter(Boolean)
              : [];
            const rows = db
              .select()
              .from(schema.storyboards)
              .where(eq(schema.storyboards.episodeId, episodeId))
              .all();
            const targets = rows.filter((sb) => {
              if (inputIds.length && !inputIds.includes(sb.id)) return false;
              return !!sb.videoUrl;
            });
            const completed: Array<{ storyboard_id: number; composed_video_url: string }> = [];
            const failed: Array<{ storyboard_id: number; error: string }> = [];
            for (const sb of targets) {
              try {
                const composedVideoUrl = await composeStoryboard(sb.id);
                completed.push({ storyboard_id: sb.id, composed_video_url: composedVideoUrl });
              } catch (err: any) {
                failed.push({
                  storyboard_id: sb.id,
                  error: err?.message || String(err),
                });
              }
            }
            return {
              total: targets.length,
              completed: completed.length,
              failed: failed.length,
              completed_items: completed,
              failed_items: failed,
            };
          },
        },
        merge_episode: {
          toolName: "merge_episode",
          description: "拼接当前集所有已合成镜头，返回 merge_id",
          parameters: {
            type: "object",
            properties: {
              episode_id: { type: "number" },
              drama_id: { type: "number" },
            },
            additionalProperties: false,
          },
          execute: async (args: any) => {
            const targetEpisodeId = args?.episode_id
              ? Number(args.episode_id)
              : episodeId;
            const targetDramaId = args?.drama_id
              ? Number(args.drama_id)
              : dramaId;
            const mergeId = await mergeEpisodeVideos(
              targetEpisodeId,
              targetDramaId,
            );
            return {
              merge_id: mergeId,
              status: "processing",
            };
          },
        },
      };
      break;
    }
    case "script_rewriter":
      tools = createScriptTools(episodeId);
      break;
    case "extractor":
      tools = createExtractTools(episodeId, dramaId);
      break;
    case "storyboard_breaker":
      tools = createStoryboardTools(episodeId, dramaId);
      break;
    case "voice_assigner":
      tools = createVoiceTools(episodeId, dramaId);
      break;
    case "grid_prompt_generator":
      tools = createGridPromptTools(episodeId, dramaId);
      break;
    default:
      return null;
  }

  const lcTools = toLangChainTools(type, episodeId, dramaId, tools);

  return {
    async generate(messages, opts) {
      const maxSteps = Math.max(1, Number(opts?.maxSteps || 20));
      const runEnabled = isLangSmithEnabled();
      const modelWithTools = model.bindTools(lcTools);
      const conversation = toLangChainMessages(
        messages,
        instructions,
      ) as Array<any>;
      const toolCalls: Array<{
        toolName: string;
        args: Record<string, unknown>;
      }> = [];
      const toolResults: Array<{
        toolName: string;
        result?: unknown;
        error?: string;
      }> = [];

      for (let step = 0; step < maxSteps; step++) {
        const llmRun = runEnabled
          ? getActiveRun()?.createChild({
              name: `${name}:llm-step-${step + 1}`,
              run_type: "llm",
              inputs: { messages: conversation.map((m: any) => m.content) },
              metadata: { agent_type: type, step: step + 1 },
            } as any)
          : null;
        const ai = await modelWithTools.invoke(conversation);
        if (llmRun) {
          try {
            llmRun.end({
              output:
                typeof ai.content === "string"
                  ? ai.content
                  : JSON.stringify(ai.content),
              tool_calls: ai.tool_calls || [],
            } as any);
            await llmRun.postRun();
          } catch {}
        }
        conversation.push(ai);

        const calls = ai.tool_calls || [];
        if (!calls.length) {
          const finalText =
            typeof ai.content === "string"
              ? ai.content
              : JSON.stringify(ai.content);
          await opts?.onEvent?.({ type: "final_text", text: finalText });
          return {
            text: finalText,
            toolCalls,
            toolResults,
          };
        }

        for (const call of calls) {
          const toolName = String(call?.name || "");
          const args = (call?.args || {}) as Record<string, unknown>;
          toolCalls.push({ toolName, args });
          await opts?.onEvent?.({
            type: "tool_call",
            step: step + 1,
            toolName,
            args,
          });
          const tool = lcTools.find((t) => t.name === toolName);
          if (!tool) {
            const err = `Tool not found: ${toolName}`;
            toolResults.push({ toolName, error: err });
            await opts?.onEvent?.({
              type: "tool_result",
              step: step + 1,
              toolName,
              error: err,
            });
            conversation.push(
              new ToolMessage({ tool_call_id: call.id!, content: err }),
            );
            continue;
          }
          try {
            const out = await tool.invoke(args);
            toolResults.push({ toolName, result: out });
            await opts?.onEvent?.({
              type: "tool_result",
              step: step + 1,
              toolName,
              result: out,
            });
            conversation.push(
              new ToolMessage({
                tool_call_id: call.id!,
                content: typeof out === "string" ? out : JSON.stringify(out),
              }),
            );
          } catch (err: any) {
            const msg = err?.message || String(err);
            toolResults.push({ toolName, error: msg });
            await opts?.onEvent?.({
              type: "tool_result",
              step: step + 1,
              toolName,
              error: msg,
            });
            conversation.push(
              new ToolMessage({
                tool_call_id: call.id!,
                content: `ERROR: ${msg}`,
              }),
            );
          }
        }
      }

      const finalText = "Agent reached max steps without final answer.";
      await opts?.onEvent?.({ type: "final_text", text: finalText });
      return { text: finalText, toolCalls, toolResults };
    },
  };
}
