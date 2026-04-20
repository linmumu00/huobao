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
            <div class="ctx-pipeline-head">
              <div class="ctx-pipeline-title">流水线进度</div>
              <button
                class="btn btn-sm ctx-enter-studio"
                :disabled="!studioEpisodeNumber"
                @click="goToStudioPage"
              >
                进入专业制作
              </button>
            </div>
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
          <template v-if="stepViewType === 'script'">
            <div class="ctx-script-grid">
              <section class="card ctx-script-card">
                <div class="extract-card-head"><span>原始内容</span></div>
                <pre class="ctx-pre">{{ stepData?.raw || "—" }}</pre>
              </section>
              <section class="card ctx-script-card">
                <div class="extract-card-head"><span>格式化剧本</span></div>
                <pre class="ctx-pre">{{ stepData?.script || "—" }}</pre>
              </section>
            </div>
          </template>

          <template v-else-if="stepViewType === 'extract'">
            <div class="extract-stage">
              <aside class="card extract-summary">
                <div class="extract-summary-kicker">Extraction Board</div>
                <div class="extract-summary-title">角色与场景结果</div>
                <div class="extract-summary-desc">
                  与剧集页一致展示提取结构，便于快速核查角色和场景数据。
                </div>
                <div class="extract-summary-stats">
                  <div class="extract-summary-stat">
                    <span>角色</span
                    ><strong>{{ stepData?.characters?.length || 0 }}</strong>
                  </div>
                  <div class="extract-summary-stat">
                    <span>场景</span
                    ><strong>{{ stepData?.scenes?.length || 0 }}</strong>
                  </div>
                </div>
              </aside>
              <div class="card extract-card">
                <div class="extract-card-head">
                  <span>角色</span
                  ><span class="tag tag-accent">{{
                    stepData?.characters?.length || 0
                  }}</span>
                </div>
                <div class="extract-list">
                  <div
                    v-for="c in stepData?.characters || []"
                    :key="c.id || c.name"
                    class="extract-row"
                  >
                    <div class="char-avatar">{{ c.name?.[0] || "?" }}</div>
                    <div class="extract-info">
                      <div class="extract-name-row">
                        <div class="extract-name">{{ c.name || "未命名" }}</div>
                        <span class="tag">{{ c.role || "角色" }}</span>
                      </div>
                      <div class="extract-meta wrap">
                        {{
                          c.description ||
                          c.appearance ||
                          c.personality ||
                          "暂无描述"
                        }}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div class="card extract-card">
                <div class="extract-card-head">
                  <span>场景</span
                  ><span class="tag tag-accent">{{
                    stepData?.scenes?.length || 0
                  }}</span>
                </div>
                <div class="extract-list">
                  <div
                    v-for="s in stepData?.scenes || []"
                    :key="s.id || `${s.location}-${s.time}`"
                    class="extract-row"
                  >
                    <div class="scene-icon">场</div>
                    <div class="extract-info">
                      <div class="extract-name-row">
                        <div class="extract-name">
                          {{ s.location || "未命名场景" }}
                        </div>
                        <span class="tag">{{ s.time || "—" }}</span>
                      </div>
                      <div class="extract-meta wrap">
                        {{ s.description || "等待补充场景描述" }}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <template v-else-if="stepViewType === 'voice'">
            <div class="voice-stage">
              <aside class="card voice-stage-panel">
                <div class="voice-stage-kicker">Voice Casting</div>
                <div class="voice-stage-title">角色声音分配台</div>
                <div class="voice-stage-stats">
                  <div class="voice-stage-stat">
                    <span class="voice-stage-stat-label">已分配</span
                    ><strong
                      >{{ stepData?.voicedCount || 0 }}/{{
                        stepData?.characters?.length || 0
                      }}</strong
                    >
                  </div>
                  <div class="voice-stage-stat">
                    <span class="voice-stage-stat-label">试听文件</span
                    ><strong
                      >{{ stepData?.sampleCount || 0 }}/{{
                        stepData?.voicedCount || 0
                      }}</strong
                    >
                  </div>
                </div>
              </aside>
              <div class="voice-grid">
                <div
                  v-for="c in stepData?.characters || []"
                  :key="c.id || c.name"
                  class="card voice-card"
                >
                  <div class="voice-char">
                    <div class="char-avatar lg">{{ c.name?.[0] || "?" }}</div>
                    <div class="voice-name">
                      <div class="voice-name-row">
                        <div class="extract-name">{{ c.name || "未命名" }}</div>
                        <span
                          class="tag"
                          :class="
                            c.voice_style || c.voiceStyle ? 'tag-success' : ''
                          "
                          >{{
                            c.voice_style || c.voiceStyle ? "已分配" : "待分配"
                          }}</span
                        >
                      </div>
                      <div class="extract-meta">{{ c.role || "角色" }}</div>
                    </div>
                  </div>
                  <div class="voice-card-text">
                    {{
                      c.description ||
                      c.personality ||
                      c.appearance ||
                      "暂无角色描述，可根据人物定位手动挑选音色。"
                    }}
                  </div>
                  <div class="voice-profile-card">
                    <div class="voice-profile-head">
                      <span class="voice-profile-name">{{
                        c.voice_style || c.voiceStyle || "—"
                      }}</span
                      ><span class="tag">{{
                        c.voice_provider || c.voiceProvider || "—"
                      }}</span>
                    </div>
                    <div
                      v-if="c.voice_sample_url || c.voiceSampleUrl"
                      class="voice-player"
                    >
                      <audio
                        :src="'/' + (c.voice_sample_url || c.voiceSampleUrl)"
                        controls
                        preload="none"
                      />
                    </div>
                    <div v-else class="voice-profile-fit">未生成试听文件</div>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <template v-else-if="stepViewType === 'storyboard'">
            <div class="split-layout">
              <div class="shot-list">
                <div class="shot-list-head">
                  <div>
                    <div class="shot-list-title">镜头序列</div>
                    <div class="shot-list-sub">
                      按镜头顺序检查内容与素材状态
                    </div>
                  </div>
                </div>
                <div class="shot-list-body">
                  <div
                    v-for="(sb, i) in stepData?.storyboards || []"
                    :key="sb.id || i"
                    :class="[
                      'shot-item',
                      { active: selectedPreviewStoryboardId === (sb.id || i) },
                    ]"
                    @click="selectedPreviewStoryboardId = sb.id || i"
                  >
                    <div class="shot-item-header">
                      <div class="shot-num">
                        #{{ String(Number(i) + 1).padStart(2, "0") }}
                      </div>
                      <span class="tag" style="font-size: 10px">{{
                        sb.shot_type || sb.shotType || "—"
                      }}</span>
                    </div>
                    <div class="shot-desc">
                      {{ sb.description || sb.title || "无描述" }}
                    </div>
                  </div>
                </div>
              </div>
              <div class="detail-panel" v-if="selectedPreviewStoryboard">
                <div class="card ctx-detail-card">
                  <div class="extract-card-head">
                    <span>镜头详情</span
                    ><span class="tag mono"
                      >{{ selectedPreviewStoryboard.duration || 10 }}s</span
                    >
                  </div>
                  <div class="ctx-detail-grid">
                    <div>
                      <strong>标题：</strong
                      >{{ selectedPreviewStoryboard.title || "—" }}
                    </div>
                    <div>
                      <strong>场景：</strong
                      >{{ selectedPreviewStoryboard.location || "—" }} ·
                      {{ selectedPreviewStoryboard.time || "—" }}
                    </div>
                    <div>
                      <strong>概述：</strong
                      >{{ selectedPreviewStoryboard.description || "—" }}
                    </div>
                    <div>
                      <strong>对白：</strong
                      >{{ selectedPreviewStoryboard.dialogue || "—" }}
                    </div>
                    <div>
                      <strong>视频提示词：</strong
                      >{{
                        selectedPreviewStoryboard.video_prompt ||
                        selectedPreviewStoryboard.videoPrompt ||
                        "—"
                      }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <template v-else-if="stepViewType === 'assets'">
            <div class="prod-grid">
              <div
                v-for="(sb, i) in stepData?.storyboards || []"
                :key="sb.id || i"
                class="card ctx-prod-card"
              >
                <div class="extract-card-head">
                  <span>镜头 #{{ String(Number(i) + 1).padStart(2, "0") }}</span
                  ><span class="tag">{{ sb.title || "镜头" }}</span>
                </div>
                <div class="ctx-prod-body">
                  <div v-for="line in sb.assetLines || []" :key="line.label">
                    <strong>{{ line.label }}：</strong>{{ line.value }}
                  </div>
                </div>
              </div>
            </div>
          </template>

          <template v-else-if="stepViewType === 'merge'">
            <div class="export-stage">
              <div class="card export-hero">
                <div class="extract-card-head"><span>整集导出状态</span></div>
                <div class="export-meta">
                  <span class="tag mono"
                    >已合成 {{ stepData?.composed || 0 }}/{{
                      stepData?.total || 0
                    }}</span
                  ><span class="dim"
                    >合并视频：{{ stepData?.mergeUrl || "—" }}</span
                  >
                </div>
                <pre class="ctx-pre">{{
                  JSON.stringify(stepData?.raw || {}, null, 2)
                }}</pre>
              </div>
            </div>
          </template>

          <template v-else>
            <div class="ctx-md" v-html="renderMarkdown(stepMarkdown)"></div>
          </template>
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
const route = useRoute();
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
const selectedPreviewStoryboardId = ref<any>(null);

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
const stepViewType = computed(() => stepData.value?.type || "markdown");
const selectedPreviewStoryboard = computed(() => {
  const list = stepData.value?.storyboards;
  if (!Array.isArray(list) || !list.length) return null;
  return (
    list.find(
      (sb: any, i: number) =>
        (sb.id || i) === selectedPreviewStoryboardId.value,
    ) || list[0]
  );
});

const currentDrama = computed(() =>
  dramas.value.find((d) => String(d.id) === selectedDramaId.value),
);
const currentEpisodes = computed(() => {
  const eps = currentDrama.value?.episodes;
  return Array.isArray(eps) ? eps : [];
});
const studioEpisodeNumber = computed(() => {
  const selected = currentEpisodes.value.find(
    (e: any) => String(e.id) === selectedEpisodeId.value,
  );
  const n =
    selected?.episode_number ||
    selected?.episodeNumber ||
    contextEpisode.value?.episode_number ||
    contextEpisode.value?.episodeNumber;
  return Number(n) || 0;
});

function onDramaChange() {
  selectedEpisodeId.value = "";
}
function goToStudioPage() {
  if (!selectedDramaId.value || !studioEpisodeNumber.value) return;
  navigateTo(
    `/drama/${selectedDramaId.value}/episode/${studioEpisodeNumber.value}`,
  );
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
  selectedPreviewStoryboardId.value = null;

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
          type: "extract",
          characters: chars,
          scenes: [],
        };
      } else {
        const voicedCount = chars.filter(
          (c: any) => c.voice_style || c.voiceStyle,
        ).length;
        const sampleCount = chars.filter(
          (c: any) => c.voice_sample_url || c.voiceSampleUrl,
        ).length;
        stepData.value = {
          type: "voice",
          characters: chars,
          voicedCount,
          sampleCount,
        };
      }
    } else if (key === "extract_scenes") {
      const scenes = await episodeAPI.scenes(epId);
      const chars = await episodeAPI.characters(epId).catch(() => []);
      stepData.value = {
        type: "extract",
        characters: chars,
        scenes,
      };
    } else if (
      key === "extract_storyboards" ||
      key === "generate_images" ||
      key === "generate_videos" ||
      key === "compose_shots"
    ) {
      const sbs = await episodeAPI.storyboards(epId);
      if (key === "extract_storyboards") {
        selectedPreviewStoryboardId.value = sbs[0]?.id ?? 0;
        stepData.value = {
          type: "storyboard",
          storyboards: sbs,
        };
      } else {
        stepData.value = {
          type: "assets",
          storyboards: sbs.map((sb: any) => ({
            ...sb,
            assetLines:
              key === "generate_images"
                ? [
                    {
                      label: "首帧",
                      value: sb.first_frame_image || sb.firstFrameImage || "—",
                    },
                    {
                      label: "尾帧",
                      value: sb.last_frame_image || sb.lastFrameImage || "—",
                    },
                    {
                      label: "参考图",
                      value: sb.composed_image || sb.composedImage || "—",
                    },
                  ]
                : key === "generate_videos"
                  ? [
                      {
                        label: "视频",
                        value: sb.video_url || sb.videoUrl || "—",
                      },
                      {
                        label: "配音",
                        value: sb.tts_audio_url || sb.ttsAudioUrl || "—",
                      },
                    ]
                  : [
                      {
                        label: "原视频",
                        value: sb.video_url || sb.videoUrl || "—",
                      },
                      {
                        label: "合成视频",
                        value:
                          sb.composed_video_url || sb.composedVideoUrl || "—",
                      },
                      {
                        label: "配音",
                        value: sb.tts_audio_url || sb.ttsAudioUrl || "—",
                      },
                    ],
          })),
        };
      }
    } else if (key === "merge_episode") {
      const res = await mergeAPI.status(epId);
      const mergeUrl = res?.merged_url || res?.mergedUrl || "—";
      const total = storyboards.value.length;
      const composed = storyboards.value.filter(
        (sb: any) => sb.composed_video_url || sb.composedVideoUrl,
      ).length;
      stepData.value = {
        type: "merge",
        composed,
        total,
        mergeUrl,
        raw: res,
      };
    } else if (key === "script_rewrite") {
      const raw = (contextEpisode.value?.content || "").trim();
      const script = (
        contextEpisode.value?.script_content ||
        contextEpisode.value?.scriptContent ||
        ""
      ).trim();
      stepData.value = { type: "script", raw, script };
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

  // 优先使用 URL 参数恢复（从制作页跳转时）
  const queryDramaId = String(route.query.dramaId || "");
  const queryEpisodeId = String(route.query.episodeId || "");
  if (
    queryDramaId &&
    dramas.value.some((d) => String(d.id) === String(queryDramaId))
  ) {
    selectedDramaId.value = String(queryDramaId);
    const eps =
      dramas.value.find((d) => String(d.id) === String(queryDramaId))
        ?.episodes || [];
    if (
      queryEpisodeId &&
      Array.isArray(eps) &&
      eps.some((e: any) => String(e.id) === String(queryEpisodeId))
    ) {
      selectedEpisodeId.value = String(queryEpisodeId);
    }
  }

  // 无 URL 参数时恢复上次选择（如果仍存在于当前项目列表里）
  if (typeof window !== "undefined") {
    try {
      if (!selectedDramaId.value) {
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
}
.ctx-pipeline-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.ctx-enter-studio {
  padding: 4px 8px;
  font-size: 10px;
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
.ctx-script-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.ctx-script-card {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.ctx-script-card .ctx-pre {
  margin: 0;
  border: 0;
  border-radius: 0;
  background: var(--bg-0);
  overflow: auto;
  flex: 1;
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
.ctx-detail-card {
  overflow: hidden;
}
.ctx-detail-grid {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12px;
  color: var(--text-1);
  line-height: 1.6;
}
.ctx-prod-card {
  overflow: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.ctx-prod-body {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12px;
  color: var(--text-1);
  line-height: 1.6;
}

/* 与 episode 页面同款结构样式 */
.extract-stage {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 12px 16px;
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
  align-items: stretch;
}
.extract-summary {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  align-self: stretch;
  position: sticky;
  top: 0;
  max-height: 100%;
}
.extract-summary-kicker {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-3);
}
.extract-summary-title {
  font-size: 20px;
  line-height: 1.05;
  font-family: var(--font-display);
  color: var(--text-0);
}
.extract-summary-desc {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.7;
}
.extract-summary-stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.extract-summary-stat {
  padding: 10px 12px;
  border-radius: 14px;
  background: rgba(19, 51, 121, 0.05);
  border: 1px solid rgba(19, 51, 121, 0.08);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.extract-summary-stat span {
  font-size: 10px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.extract-summary-stat strong {
  font-size: 18px;
  color: var(--text-0);
  font-family: var(--font-display);
}
.extract-card {
  overflow: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.extract-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  font-size: 12px;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
  background: var(--bg-1);
  color: var(--text-1);
}
.extract-list {
  padding: 8px 14px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.extract-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 0;
}
.extract-row + .extract-row {
  border-top: 1px solid var(--border);
}
.char-avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--accent-bg);
  color: var(--accent-text);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  flex-shrink: 0;
}
.char-avatar.lg {
  width: 38px;
  height: 38px;
  font-size: 16px;
}
.scene-icon {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  flex-shrink: 0;
  font-size: 11px;
}
.extract-info {
  min-width: 0;
}
.extract-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.extract-name {
  font-size: 13px;
  font-weight: 600;
}
.extract-meta {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.extract-meta.wrap {
  white-space: normal;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
}

.voice-stage {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px;
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 12px;
}
.voice-stage-panel {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  align-self: start;
  position: sticky;
  top: 0;
  min-height: 0;
  max-height: calc(100vh - 210px);
  overflow: hidden;
}
.voice-stage-kicker {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-3);
}
.voice-stage-title {
  font-size: 20px;
  line-height: 1.05;
  font-family: var(--font-display);
  color: var(--text-0);
}
.voice-stage-stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.voice-stage-stat {
  padding: 10px 12px;
  border-radius: 14px;
  background: rgba(19, 51, 121, 0.05);
  border: 1px solid rgba(19, 51, 121, 0.08);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.voice-stage-stat-label {
  font-size: 10px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.voice-stage-stat strong {
  font-size: 18px;
  color: var(--text-0);
  font-family: var(--font-display);
}
.voice-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
  align-content: start;
}
.voice-card {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  border-radius: 22px;
  min-height: 0;
}
.voice-char {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}
.voice-name {
  min-width: 0;
  flex: 1;
}
.voice-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.voice-card-text {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-2);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.voice-profile-card {
  padding: 12px;
  border-radius: 16px;
  background: linear-gradient(
    135deg,
    rgba(19, 51, 121, 0.08),
    rgba(255, 255, 255, 0.78)
  );
  border: 1px solid rgba(19, 51, 121, 0.1);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.voice-profile-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.voice-profile-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--accent-text);
}
.voice-profile-fit {
  font-size: 10px;
  color: var(--text-2);
  line-height: 1.5;
}

.split-layout {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}
.shot-list {
  width: 296px;
  flex-shrink: 0;
  overflow-y: auto;
  border-right: 1px solid var(--border);
  background: var(--bg-0);
}
.shot-list-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 11px 12px 10px;
  border-bottom: 1px solid rgba(27, 41, 64, 0.06);
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(10px);
}
.shot-list-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-0);
}
.shot-list-sub {
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.45;
}
.shot-list-body {
  padding: 6px;
}
.shot-item {
  position: relative;
  padding: 10px 11px;
  cursor: pointer;
  border: 1px solid transparent;
  border-left: 3px solid transparent;
  transition: all 0.15s;
  display: flex;
  flex-direction: column;
  gap: 5px;
  border-radius: 14px;
}
.shot-item + .shot-item {
  margin-top: 6px;
}
.shot-item:hover {
  background: var(--bg-hover);
  border-color: rgba(27, 41, 64, 0.06);
}
.shot-item.active {
  background: var(--bg-0);
  border-left-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent-glow);
  z-index: 1;
}
.shot-item-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.shot-num {
  font-size: 11px;
  font-family: var(--font-mono);
  font-weight: 700;
  color: var(--accent);
  background: var(--accent-bg);
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
  letter-spacing: 0.03em;
}
.shot-item.active .shot-num {
  background: var(--accent);
  color: #fff;
}
.shot-desc {
  font-size: 12px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: var(--text-1);
}
.detail-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  min-width: 0;
  padding: 0 0 0 12px;
}

.prod-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 12px;
}
.export-stage {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.export-hero {
  overflow: hidden;
}
.export-meta {
  padding: 12px 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

:deep(.tag) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  background: rgba(27, 41, 64, 0.06);
  color: var(--text-2);
}
:deep(.tag-accent) {
  background: var(--accent-bg);
  color: var(--accent-text);
}
:deep(.tag-success) {
  background: rgba(39, 174, 96, 0.12);
  color: var(--success, #2ea664);
}
:deep(.tag.mono) {
  font-family: var(--font-mono);
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
