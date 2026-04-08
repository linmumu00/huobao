<template>
  <div class="chat-page">
    <div class="chat-head">
      <h1 class="chat-title">AI 对话工作台</h1>
      <p class="chat-desc">
        左侧选择剧集并查看流水线与分镜统计；右侧对话支持执行计划预览、一键执行与工具调用追踪。
      </p>
    </div>

    <div class="chat-layout card">
      <!-- 左侧：剧集上下文 -->
      <aside class="chat-context">
        <div class="ctx-block">
          <div class="ctx-label">项目</div>
          <select
            v-model="selectedDramaId"
            class="ctx-select"
            @change="onDramaChange"
          >
            <option value="">选择项目…</option>
            <option v-for="d in dramas" :key="d.id" :value="String(d.id)">
              {{ d.title }}
            </option>
          </select>
        </div>
        <div class="ctx-block">
          <div class="ctx-label">剧集</div>
          <select
            v-model="selectedEpisodeId"
            class="ctx-select"
            :disabled="!currentDrama"
          >
            <option value="">选择剧集…</option>
            <option
              v-for="e in currentEpisodes"
              :key="e.id"
              :value="String(e.id)"
            >
              第 {{ e.episode_number || e.episodeNumber }} 集 ·
              {{ e.title || "未命名" }}
            </option>
          </select>
        </div>
        <button
          type="button"
          class="btn btn-ghost btn-sm ctx-refresh"
          :disabled="!selectedEpisodeId"
          @click="loadContext"
        >
          刷新上下文
        </button>

        <div v-if="ctxLoading" class="ctx-muted">加载中…</div>

        <template v-else-if="selectedEpisodeId && contextEpisode">
          <div class="ctx-summary">
            <div class="ctx-kicker">当前剧集</div>
            <div class="ctx-title">{{ contextDrama?.title || "—" }}</div>
            <div class="ctx-sub">
              第
              {{
                contextEpisode.episode_number || contextEpisode.episodeNumber
              }}
              集 · {{ contextEpisode.title || "未命名" }}
            </div>
          </div>

          <div class="ctx-stats">
            <div class="ctx-stat">
              <span class="ctx-stat-val">{{ storyboardStats.total }}</span>
              <span class="ctx-stat-key">分镜数</span>
            </div>
            <div class="ctx-stat">
              <span class="ctx-stat-val">{{ storyboardStats.withVideo }}</span>
              <span class="ctx-stat-key">已生成视频</span>
            </div>
            <div class="ctx-stat">
              <span class="ctx-stat-val">{{ storyboardStats.withTts }}</span>
              <span class="ctx-stat-key">已生成配音</span>
            </div>
            <div class="ctx-stat">
              <span class="ctx-stat-val">{{ storyboardStats.composed }}</span>
              <span class="ctx-stat-key">已合成镜头</span>
            </div>
          </div>

          <div v-if="pipelineSteps.length" class="ctx-pipeline">
            <div class="ctx-pipeline-title">流水线进度</div>
            <ul class="ctx-pipeline-list">
              <li
                v-for="row in pipelineSteps"
                :key="row.key"
                class="ctx-pipeline-item"
                @click="openStep(row.key)"
              >
                <span class="ctx-pipe-label">{{ row.label }}</span>
                <span :class="['ctx-pipe-status', `is-${row.status}`]">{{
                  row.statusLabel
                }}</span>
              </li>
            </ul>
          </div>
        </template>

        <div v-else class="ctx-muted">请选择项目与剧集以加载上下文。</div>
      </aside>

      <!-- 右侧：React Assistant UI -->
      <div class="chat-main">
        <div id="assistant-ui-root" ref="mountEl" class="chat-mount"></div>
      </div>
    </div>

    <!-- 进度详情弹窗 -->
    <div v-if="stepDialog" class="ctx-overlay" @click.self="stepDialog = false">
      <div class="ctx-modal card">
        <div class="ctx-modal-head">
          <div>
            <div class="ctx-modal-kicker">进度详情</div>
            <div class="ctx-modal-title">{{ stepTitle }}</div>
            <div class="ctx-modal-sub dim">
              {{ contextDrama?.title }} · 第
              {{
                contextEpisode?.episode_number || contextEpisode?.episodeNumber
              }}
              集
            </div>
          </div>
          <button class="btn btn-ghost btn-sm" @click="stepDialog = false">
            关闭
          </button>
        </div>

        <div v-if="stepLoading" class="ctx-muted" style="padding: 8px 0">
          加载中…
        </div>
        <div v-else-if="stepError" class="ctx-error">{{ stepError }}</div>

        <div v-else class="ctx-modal-body">
          <div class="ctx-md" v-html="renderMarkdown(stepMarkdown)"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { toast } from "vue-sonner";
import { dramaAPI, episodeAPI, mergeAPI } from "~/composables/useApi";
import { renderMarkdown } from "~/lib/markdown";

const STORAGE_KEY = "huobao.chat.selection.v1";

const mountEl = ref<HTMLElement | null>(null);
let root: { render: (node: any) => void; unmount: () => void } | null = null;

const dramas = ref<any[]>([]);
const selectedDramaId = ref("");
const selectedEpisodeId = ref("");
const ctxLoading = ref(false);
const contextDrama = ref<any>(null);
const contextEpisode = ref<any>(null);
const pipeline = ref<any>(null);
const storyboards = ref<any[]>([]);

// step modal
const stepDialog = ref(false);
const stepKey = ref<string>("");
const stepLoading = ref(false);
const stepError = ref("");
const stepData = ref<any>(null);

const stepTitle = computed(() => {
  const row = pipelineSteps.value.find((r) => r.key === stepKey.value);
  return row?.label || stepKey.value || "进度";
});

const stepMarkdown = computed(() => {
  const key = stepKey.value;
  if (!key) return "";
  if (key === "script_rewrite") {
    const raw = (contextEpisode.value?.content || "").trim();
    const script = (
      contextEpisode.value?.script_content ||
      contextEpisode.value?.scriptContent ||
      ""
    ).trim();
    return [
      "## 原始内容",
      raw ? ["```text", raw, "```"].join("\n") : "—",
      "",
      "## 格式化剧本",
      script ? ["```text", script, "```"].join("\n") : "—",
    ].join("\n");
  }
  return stepData.value?.markdown || "—";
});

const currentDrama = computed(() =>
  dramas.value.find((d) => String(d.id) === selectedDramaId.value),
);
const currentEpisodes = computed(() => {
  const eps = currentDrama.value?.episodes;
  return Array.isArray(eps) ? eps : [];
});

function onDramaChange() {
  selectedEpisodeId.value = "";
}

const storyboardStats = computed(() => {
  const list = storyboards.value || [];
  let withVideo = 0;
  let withTts = 0;
  let composed = 0;
  for (const sb of list) {
    if (sb.video_url || sb.videoUrl) withVideo++;
    if (sb.tts_audio_url || sb.ttsAudioUrl) withTts++;
    if (sb.composed_video_url || sb.composedVideoUrl) composed++;
  }
  return { total: list.length, withVideo, withTts, composed };
});

const pipelineSteps = computed(() => {
  const steps = pipeline.value?.steps;
  if (!steps || typeof steps !== "object") return [];
  const labels: Record<string, string> = {
    script_rewrite: "剧本",
    extract_characters: "角色提取",
    extract_scenes: "场景提取",
    assign_voices: "分配音色",
    generate_voice_samples: "试听生成",
    extract_storyboards: "分镜拆解",
    generate_images: "镜头图",
    generate_videos: "视频生成",
    compose_shots: "镜头合成",
    merge_episode: "整集拼接",
  };
  return Object.entries(steps).map(([key, val]: [string, any]) => {
    const st = val?.status || "pending";
    let statusLabel = st;
    if (st === "done") statusLabel = "完成";
    else if (st === "pending") statusLabel = "待开始";
    else if (st === "partial") statusLabel = "进行中";
    else if (st === "ready") statusLabel = "可执行";
    return { key, label: labels[key] || key, status: st, statusLabel };
  });
});

async function loadDramaList() {
  try {
    const res = await dramaAPI.list();
    dramas.value = res.items || [];
  } catch (e: any) {
    toast.error(e.message || "加载项目列表失败");
  }
}

async function loadContext() {
  const epId = Number(selectedEpisodeId.value);
  const drId = Number(selectedDramaId.value);
  if (!epId || !drId) return;
  ctxLoading.value = true;
  try {
    const [d, sbs, pipe] = await Promise.all([
      dramaAPI.get(drId),
      episodeAPI.storyboards(epId),
      episodeAPI.pipelineStatus(epId).catch(() => null),
    ]);
    contextDrama.value = d;
    contextEpisode.value = (d?.episodes || []).find(
      (e: any) => e.id === epId,
    ) || { id: epId };
    storyboards.value = Array.isArray(sbs) ? sbs : [];
    pipeline.value = pipe;
  } catch (e: any) {
    toast.error(e.message || "加载上下文失败");
  } finally {
    ctxLoading.value = false;
  }
}

async function openStep(key: string) {
  if (!selectedDramaId.value || !selectedEpisodeId.value) return;
  stepKey.value = key;
  stepDialog.value = true;
  stepLoading.value = true;
  stepError.value = "";
  stepData.value = null;

  const epId = Number(selectedEpisodeId.value);
  try {
    if (
      key === "extract_characters" ||
      key === "assign_voices" ||
      key === "generate_voice_samples"
    ) {
      const chars = await episodeAPI.characters(epId);
      if (key === "extract_characters") {
        stepData.value = {
          markdown: [
            `## 角色列表（${chars.length}）`,
            ...chars.map((c: any, i: number) =>
              [
                `### #${i + 1} ${c.name}${c.role ? ` · ${c.role}` : ""}`.trim(),
                `- 描述：${c.description || "—"}`,
                `- 外貌：${c.appearance || "—"}`,
                `- 性格：${c.personality || "—"}`,
              ].join("\n"),
            ),
          ].join("\n\n"),
        };
      } else {
        stepData.value = {
          markdown: [
            "## 角色音色与试听",
            ...chars.map((c: any, i: number) =>
              [
                `### #${i + 1} ${c.name}`,
                `- voice_style：${c.voice_style || c.voiceStyle || "—"}`,
                `- voice_provider：${c.voice_provider || c.voiceProvider || "—"}`,
                `- sample：${c.voice_sample_url || c.voiceSampleUrl || "—"}`,
              ].join("\n"),
            ),
          ].join("\n\n"),
        };
      }
    } else if (key === "extract_scenes") {
      const scenes = await episodeAPI.scenes(epId);
      stepData.value = {
        markdown: [
          `## 场景列表（${scenes.length}）`,
          ...scenes.map((s: any, i: number) =>
            [
              `### #${i + 1} ${s.location} · ${s.time}`,
              `- prompt：${s.prompt || "—"}`,
              `- image：${s.image_url || s.imageUrl || "—"}`,
            ].join("\n"),
          ),
        ].join("\n\n"),
      };
    } else if (
      key === "extract_storyboards" ||
      key === "generate_images" ||
      key === "generate_videos" ||
      key === "compose_shots"
    ) {
      const sbs = await episodeAPI.storyboards(epId);
      if (key === "extract_storyboards") {
        stepData.value = {
          markdown: [
            `## 分镜列表（${sbs.length}）`,
            ...sbs.map((sb: any, i: number) =>
              [
                `### #${i + 1} 镜头${sb.storyboard_number || sb.storyboardNumber || sb.id} ${sb.title || ""}`.trim(),
                `- 场景：${sb.location || "—"} · ${sb.time || "—"}`,
                `- 对白：${(sb.dialogue || "").trim() || "—"}`,
                `- video_prompt：${(sb.video_prompt || sb.videoPrompt || "").trim() || "—"}`,
              ].join("\n"),
            ),
          ].join("\n\n"),
        };
      } else {
        stepData.value = {
          markdown: [
            "## 镜头产物状态",
            ...sbs.map((sb: any, i: number) =>
              [
                `### #${i + 1} 镜头${sb.storyboard_number || sb.storyboardNumber || sb.id} ${sb.title || ""}`.trim(),
                `- img：${sb.composed_image || sb.composedImage || sb.first_frame_image || sb.firstFrameImage || "—"}`,
                `- tts：${sb.tts_audio_url || sb.ttsAudioUrl || "—"}`,
                `- video：${sb.video_url || sb.videoUrl || "—"}`,
                `- composed：${sb.composed_video_url || sb.composedVideoUrl || "—"}`,
              ].join("\n"),
            ),
          ].join("\n\n"),
        };
      }
    } else if (key === "merge_episode") {
      const res = await mergeAPI.status(epId);
      stepData.value = {
        markdown: ["```json", JSON.stringify(res, null, 2), "```"].join("\n"),
      };
    } else if (key === "script_rewrite") {
      // 已在 contextEpisode 里显示
      stepData.value = {};
    } else {
      stepData.value = {};
    }
  } catch (e: any) {
    stepError.value = e.message || "加载失败";
  } finally {
    stepLoading.value = false;
  }
}

watch([selectedDramaId, selectedEpisodeId], ([d, e]) => {
  if (d && e) loadContext();
  else {
    contextDrama.value = null;
    contextEpisode.value = null;
    storyboards.value = [];
    pipeline.value = null;
  }

  // 持久化选择，刷新可恢复
  if (typeof window !== "undefined") {
    const payload = { dramaId: d || "", episodeId: e || "" };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }
});

onMounted(async () => {
  await loadDramaList();

  // 恢复上次选择（如果仍存在于当前项目列表里）
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (
          saved?.dramaId &&
          dramas.value.some((d) => String(d.id) === String(saved.dramaId))
        ) {
          selectedDramaId.value = String(saved.dramaId);
          // 只有在当前 drama 的 episode 列表中存在才恢复
          const eps =
            dramas.value.find((d) => String(d.id) === String(saved.dramaId))
              ?.episodes || [];
          if (
            saved?.episodeId &&
            Array.isArray(eps) &&
            eps.some((e: any) => String(e.id) === String(saved.episodeId))
          ) {
            selectedEpisodeId.value = String(saved.episodeId);
          }
        }
      }
    } catch {}
  }

  const { createChatAssistantApp } = await import("~/lib/chatAssistantApp");
  const React = await import("react");
  const ReactDOMClient = await import("react-dom/client");
  if (!mountEl.value) return;
  root = ReactDOMClient.createRoot(mountEl.value);

  const render = () => {
    const Assistant = createChatAssistantApp();
    root!.render(
      React.createElement(Assistant, {
        dramaId: selectedDramaId.value,
        episodeId: selectedEpisodeId.value,
        onAfterRun: () => loadContext(),
      }),
    );
  };
  render();
  watch([selectedDramaId, selectedEpisodeId], render);
});

onBeforeUnmount(() => {
  root?.unmount();
  root = null;
});
</script>

<style scoped>
.chat-page {
  height: 100%;
  padding: 20px 24px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}
.chat-head {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.chat-title {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 700;
  color: var(--text-0);
}
.chat-desc {
  font-size: 13px;
  color: var(--text-3);
}

.chat-layout {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(260px, 320px) 1fr;
  gap: 0;
  min-height: 0;
  overflow: hidden;
  padding: 0;
}

.chat-context {
  border-right: 1px solid var(--border);
  background: var(--bg-1);
  padding: 16px 14px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ctx-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ctx-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.ctx-select {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-0);
  padding: 8px 10px;
  font-size: 12px;
  color: var(--text-1);
}
.ctx-refresh {
  align-self: flex-start;
}
.ctx-muted {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.5;
}
.ctx-summary {
  padding: 12px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.65);
}
.ctx-kicker {
  font-size: 10px;
  font-weight: 700;
  color: var(--text-3);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-bottom: 6px;
}
.ctx-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-0);
}
.ctx-sub {
  font-size: 12px;
  color: var(--text-2);
  margin-top: 4px;
}

.ctx-stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.ctx-stat {
  padding: 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-0);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ctx-stat-val {
  font-size: 18px;
  font-weight: 700;
  font-family: var(--font-mono);
  color: var(--accent-text);
}
.ctx-stat-key {
  font-size: 10px;
  color: var(--text-3);
}

.ctx-pipeline-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
  margin-bottom: 6px;
}
.ctx-pipeline-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ctx-pipeline-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  padding: 5px 8px;
  border-radius: 8px;
  background: var(--bg-0);
  border: 1px solid rgba(27, 41, 64, 0.06);
  cursor: pointer;
}
.ctx-pipeline-item:hover {
  border-color: rgba(76, 125, 255, 0.25);
  background: rgba(244, 248, 255, 0.85);
}
.ctx-pipe-label {
  color: var(--text-2);
}
.ctx-pipe-status {
  font-size: 10px;
  font-weight: 600;
}
.ctx-pipe-status.is-done {
  color: var(--success, #4caf50);
}
.ctx-pipe-status.is-pending {
  color: var(--text-3);
}
.ctx-pipe-status.is-partial {
  color: var(--accent);
}

.chat-main {
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.chat-mount {
  flex: 1;
  min-height: 0;
}

.ctx-overlay {
  position: fixed;
  inset: 0;
  background: rgba(34, 45, 66, 0.32);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.ctx-modal {
  width: min(920px, calc(100vw - 40px));
  max-height: calc(100vh - 56px);
  overflow: hidden;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ctx-modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.ctx-modal-kicker {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-3);
}
.ctx-modal-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-0);
  margin-top: 4px;
}
.ctx-modal-body {
  overflow: auto;
  padding-right: 2px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ctx-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ctx-sec-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
}
.ctx-pre {
  margin: 0;
  padding: 10px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.8);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono);
  color: var(--text-1);
}

.ctx-md :deep(h2) {
  font-size: 14px;
  margin: 12px 0 8px;
}
.ctx-md :deep(h3) {
  font-size: 13px;
  margin: 10px 0 6px;
}
.ctx-md :deep(p) {
  margin: 6px 0;
}
.ctx-md :deep(ul) {
  margin: 6px 0 6px 18px;
}
.ctx-md :deep(code) {
  font-family: var(--font-mono);
}
.ctx-md :deep(pre) {
  margin: 8px 0;
  padding: 10px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: rgba(27, 41, 64, 0.04);
  overflow: auto;
}
.ctx-md :deep(pre code) {
  font-size: 12px;
}
.ctx-error {
  color: var(--error);
  font-size: 12px;
}
</style>

<style>
/* 右侧 React 区域全局样式（非 scoped） */
.aui-shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.aui-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.7);
  align-items: flex-end;
}
.aui-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--text-3);
  min-width: 140px;
}
.aui-field input,
.aui-field select {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-0);
  padding: 7px 10px;
  font-size: 12px;
  color: var(--text-1);
}
.aui-hint {
  font-size: 11px;
  color: var(--text-3);
  padding: 0 12px 8px;
}
.aui-error {
  margin: 0 12px 8px;
  color: var(--error);
  font-size: 12px;
}

.aui-plan-panel {
  border-bottom: 1px solid var(--border);
  background: rgba(244, 248, 255, 0.85);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.aui-plan-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.aui-plan-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
}
.aui-plan-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.aui-btn {
  border-radius: 10px;
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid var(--border);
  background: var(--bg-0);
  color: var(--text-1);
}
.aui-btn-primary {
  border-color: rgba(76, 125, 255, 0.35);
  background: var(--accent-bg);
  color: var(--accent-text);
}
.aui-plan-textarea {
  width: 100%;
  min-height: 72px;
  border: 1px dashed var(--border);
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--text-1);
  background: var(--bg-0);
  resize: vertical;
  font-family: inherit;
}
.aui-plan-empty {
  font-size: 11px;
  color: var(--text-3);
}

.aui-trace {
  border-top: 1px solid var(--border);
  background: var(--bg-1);
  max-height: 220px;
  overflow: auto;
  flex-shrink: 0;
}
.aui-trace-head {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-2);
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.aui-trace-empty {
  padding: 12px;
  font-size: 11px;
  color: var(--text-3);
}
.aui-trace-list {
  padding: 8px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.aui-trace-item {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-0);
  overflow: hidden;
}
.aui-trace-item summary {
  cursor: pointer;
  padding: 8px 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-1);
  list-style: none;
  display: flex;
  align-items: center;
  gap: 8px;
}
.aui-trace-item summary::-webkit-details-marker {
  display: none;
}
.aui-trace-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--accent-bg);
  color: var(--accent-text);
  font-family: var(--font-mono);
}
.aui-trace-body {
  padding: 0 10px 10px;
  font-size: 10px;
  color: var(--text-2);
  display: grid;
  gap: 6px;
}
.aui-trace-pre {
  margin: 0;
  padding: 8px;
  border-radius: 8px;
  background: rgba(27, 41, 64, 0.04);
  overflow: auto;
  max-height: 120px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono);
}

.aui-thread-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.aui-thread {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.aui-viewport {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.aui-message-row {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 100%;
}
.aui-message {
  padding: 14px;
  max-width: 92%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-0);
}
.aui-message.user {
  align-self: flex-end;
  background: var(--accent-bg);
  border-color: rgba(76, 125, 255, 0.2);
}
.aui-message.assistant {
  align-self: flex-start;
}
.aui-md :is(p, ul, ol, pre) {
  margin: 6px 0;
  padding: 0 12px;
}
.aui-md pre {
  padding: 10px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: rgba(27, 41, 64, 0.04);
  overflow: auto;
}
.aui-md code {
  font-family: var(--font-mono);
}
.aui-md h1,
.aui-md h2,
.aui-md h3 {
  margin: 10px 0 6px;
}
.aui-footer {
  padding: 12px;
  border-top: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.92);
}
.aui-composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.aui-input {
  flex: 1;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 9px 10px;
  min-height: 54px;
  font-size: 13px;
  color: var(--text-1);
  background: var(--bg-0);
  resize: none;
}
.aui-send {
  border: 1px solid rgba(76, 125, 255, 0.25);
  background: var(--accent-bg);
  color: var(--accent-text);
  border-radius: 10px;
  padding: 8px 14px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}
</style>
