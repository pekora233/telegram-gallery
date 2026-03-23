<script setup>
import { computed, ref, onMounted, onUnmounted, watch } from "vue";
import PhotoSwipeLightbox from "photoswipe/lightbox";
import "photoswipe/style.css";

const props = defineProps({
  entries: Array,
  currentIndex: Number,
  onClose: Function,
  onPrev: Function,
  onNext: Function,
  onSetIndex: Function,
  onRefresh: Function,
  onNeedMore: Function
});

const copySuccess = ref("");
let lightbox = null;
let lightboxDataSource = [];
const PHOTOSWIPE_AUTO_LOAD_THRESHOLD = 5;
const LONG_PROMPT_MIN_LENGTH = 120;
const LONG_PROMPT_MIN_AVG_SEGMENT = 18;
const LONG_PROMPT_SEGMENT_LENGTH = 28;

const currentEntry = computed(() => props.entries[props.currentIndex]);

function getDisplayFileId(entry) {
  return entry?.telegram?.file_id_lossy || entry?.telegram?.file_id || null;
}

function getOriginalFormat(entry) {
  return entry?.telegram?.file_id_format || null;
}

const canDownloadOriginal = computed(() =>
  Boolean(currentEntry.value?.telegram?.file_id)
);

function getOriginalDownloadUrl() {
  const fileId = currentEntry.value?.telegram?.file_id;
  if (!fileId) return "";
  const fmt = getOriginalFormat(currentEntry.value);
  const filename = fmt ? `image.${fmt}` : "image";
  return `/api/file/${encodeURIComponent(fileId)}/${filename}?t=${Date.now()}`;
}

const metaLines = computed(() => {
  const m = currentEntry.value?.metadata || {};
  const lines = [];
  if (m.model) lines.push({ label: "模型", value: m.model });
  if (m.seed) lines.push({ label: "种子", value: m.seed });
  if (m.steps) lines.push({ label: "步数", value: m.steps });
  if (m.cfg_scale) lines.push({ label: "CFG Scale", value: m.cfg_scale });
  if (m.sampler_name) lines.push({ label: "采样器", value: m.sampler_name });
  if (m.width && m.height)
    lines.push({ label: "尺寸", value: `${m.width} × ${m.height}` });
  return lines;
});

const negativePrompt = computed(() => {
  return currentEntry.value?.metadata?.negative_prompt || null;
});

function splitPromptSegments(prompt) {
  return String(prompt || "")
    .replace(/[()]/g, "")
    .split(/[,\n，]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function buildPromptDisplay(prompt) {
  const text = String(prompt || "").trim();
  if (!text) {
    return {
      text: "",
      tags: [],
      isLongText: false,
    };
  }

  const tags = splitPromptSegments(text);
  const totalTagLength = tags.reduce((sum, tag) => sum + tag.length, 0);
  const avgTagLength = tags.length ? totalTagLength / tags.length : 0;
  const longTagCount = tags.filter((tag) => tag.length >= LONG_PROMPT_SEGMENT_LENGTH).length;
  const hasLineBreak = /\r?\n/.test(text);
  const hasParagraphPunctuation = /[。；：！？]/.test(text);

  const isLongText =
    hasLineBreak ||
    text.length >= 220 ||
    (text.length >= LONG_PROMPT_MIN_LENGTH && tags.length <= 4) ||
    (text.length >= LONG_PROMPT_MIN_LENGTH && avgTagLength >= LONG_PROMPT_MIN_AVG_SEGMENT) ||
    (text.length >= 90 && hasParagraphPunctuation && avgTagLength >= 12) ||
    (text.length >= 100 && longTagCount >= Math.max(2, Math.ceil(tags.length * 0.4)));

  return {
    text,
    tags: isLongText ? [] : tags,
    isLongText,
  };
}

const promptDisplay = computed(() => buildPromptDisplay(currentEntry.value?.prompt));
const negativePromptDisplay = computed(() => buildPromptDisplay(negativePrompt.value));

const promptTags = computed(() => promptDisplay.value.tags);
const negativePromptTags = computed(() => negativePromptDisplay.value.tags);
const hasSelectableTags = computed(() =>
  promptTags.value.length > 0 || negativePromptTags.value.length > 0
);

const isMultiSelectMode = ref(false);
const selectedTags = ref([]);

function toggleMultiSelect() {
  if (!hasSelectableTags.value) return;
  isMultiSelectMode.value = !isMultiSelectMode.value;
  if (!isMultiSelectMode.value) {
    selectedTags.value = [];
  }
}

function handleTagClick(tag) {
  if (isMultiSelectMode.value) {
    const idx = selectedTags.value.indexOf(tag);
    if (idx > -1) {
      selectedTags.value.splice(idx, 1);
    } else {
      selectedTags.value.push(tag);
    }
  } else {
    copyToClipboard(tag, "标签");
  }
}

function copySelected() {
  if (selectedTags.value.length === 0) return;
  copyToClipboard(selectedTags.value.join(", "), "选中的标签");
  isMultiSelectMode.value = false;
  selectedTags.value = [];
}

watch(
  () => props.currentIndex,
  () => {
    isMultiSelectMode.value = false;
    selectedTags.value = [];
  }
);

watch(hasSelectableTags, (enabled) => {
  if (enabled || !isMultiSelectMode.value) return;
  isMultiSelectMode.value = false;
  selectedTags.value = [];
});

async function copyToClipboard(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    copySuccess.value = label;
    setTimeout(() => {
      copySuccess.value = "";
    }, 2000);
  } catch (err) {
    console.error("Failed to copy:", err);
  }
}

function copyAllInfo() {
  const allInfo = [];
  allInfo.push(`正向提示词: ${currentEntry.value.prompt}`);
  if (negativePrompt.value) {
    allInfo.push(`负向提示词: ${negativePrompt.value}`);
  }
  metaLines.value.forEach((item) => {
    allInfo.push(`${item.label}: ${item.value}`);
  });
  copyToClipboard(allInfo.join("\n"), "全部信息");
}

const isDownloading = ref(false);

async function downloadOriginalImage() {
  if (!canDownloadOriginal.value || isDownloading.value) return;
  isDownloading.value = true;
  try {
    const url = getOriginalDownloadUrl();
    if (!url) return;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("Download failed");

    // Try to get filename from Content-Disposition header
    const disposition = resp.headers.get("content-disposition") || "";
    const filenameMatch = disposition.match(/filename="?([^";\s]+)"?/);
    let filename = filenameMatch ? filenameMatch[1] : null;

    if (!filename) {
      const fmt = getOriginalFormat(currentEntry.value);
      if (fmt) {
        const entryId = currentEntry.value?.id || Date.now();
        filename = `image-${entryId}.${fmt}`;
      } else {
        const contentType = resp.headers.get("content-type") || "image/png";
        const extMap = {
          "image/png": "png",
          "image/jpeg": "jpg",
          "image/webp": "webp",
          "image/gif": "gif",
          "image/avif": "avif",
          "image/jxl": "jxl",
          "image/bmp": "bmp"
        };
        const base = contentType.split(";")[0].trim().toLowerCase();
        const ext = extMap[base] || "png";
        const entryId = currentEntry.value?.id || Date.now();
        filename = `image-${entryId}.${ext}`;
      }
    }

    const blob = await resp.blob();
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(blobUrl);
  } catch (err) {
    console.error("Download failed:", err);
  } finally {
    isDownloading.value = false;
  }
}

function toPhotoSwipeItem(entry) {
  const displayFileId = getDisplayFileId(entry);
  const fmt =
    entry?.telegram?.file_id_lossy_format ||
    entry?.telegram?.file_id_format ||
    null;
  const filename = fmt ? `image.${fmt}` : "image";
  const fallbackSrc = displayFileId
    ? `/api/file/${encodeURIComponent(displayFileId)}/${filename}`
    : "";
  return {
    src: entry?.src || fallbackSrc,
    width: entry?.metadata?.width || 1200,
    height: entry?.metadata?.height || 1600,
    alt: entry?.prompt || ""
  };
}

function maybeRequestMore(currentIndex = props.currentIndex) {
  if (typeof props.onNeedMore !== "function") return;
  if (!Number.isFinite(currentIndex) || currentIndex < 0) return;

  const remaining = props.entries.length - 1 - currentIndex;
  if (remaining <= PHOTOSWIPE_AUTO_LOAD_THRESHOLD) {
    props.onNeedMore(currentIndex);
  }
}

function syncPhotoSwipeDataSource() {
  if (!lightbox || !Array.isArray(lightboxDataSource)) return;
  const targetLen = props.entries.length;
  const currentLen = lightboxDataSource.length;
  if (targetLen <= currentLen) return;

  for (let i = currentLen; i < targetLen; i++) {
    lightboxDataSource.push(toPhotoSwipeItem(props.entries[i]));
  }

  if (lightbox.pswp) {
    lightbox.pswp.options.dataSource = lightboxDataSource;
  }
}

function openPhotoSwipe() {
  if (lightbox) {
    lightbox.destroy();
    lightbox = null;
  }
  lightboxDataSource = props.entries.map((entry) => toPhotoSwipeItem(entry));

  lightbox = new PhotoSwipeLightbox({
    dataSource: lightboxDataSource,
    pswpModule: () => import("photoswipe"),
    index: props.currentIndex,
    bgOpacity: 0.95,
    spacing: 0.1,
    showHideAnimationType: "fade"
  });

  lightbox.on("change", () => {
    const newIndex = lightbox.pswp.currIndex;
    if (newIndex !== props.currentIndex) {
      if (typeof props.onSetIndex === "function") {
        props.onSetIndex(newIndex);
      } else if (newIndex > props.currentIndex) {
        props.onNext();
      } else {
        props.onPrev();
      }
    }
    maybeRequestMore(newIndex);
  });

  lightbox.on("close", () => {
    if (lightbox) {
      lightbox.destroy();
      lightbox = null;
    }
    lightboxDataSource = [];
  });

  lightbox.init();
  lightbox.loadAndOpen(props.currentIndex);
  maybeRequestMore(props.currentIndex);
}

function handleKeydown(e) {
  if (lightbox && lightbox.pswp) return;

  if (e.key === "ArrowLeft" && props.onPrev) {
    props.onPrev();
  } else if (e.key === "ArrowRight" && props.onNext) {
    props.onNext();
  } else if (e.key === "Escape" && props.onClose) {
    props.onClose();
  }
}

watch(
  () => props.entries.length,
  (newLen, oldLen) => {
    if (newLen === oldLen) return;
    syncPhotoSwipeDataSource();
    if (lightbox?.pswp) {
      maybeRequestMore(lightbox.pswp.currIndex);
    }
  }
);

onMounted(() => {
  document.body.style.overflow = "hidden";
  document.addEventListener("keydown", handleKeydown);
});

onUnmounted(() => {
  if (lightbox) {
    lightbox.destroy();
    lightbox = null;
  }
  lightboxDataSource = [];
  document.body.style.overflow = "";
  document.removeEventListener("keydown", handleKeydown);
});
</script>

<template>
  <div class="viewer-container">
    <!-- 顶部导航栏 -->
    <div class="top-navbar">
      <div class="navbar-left">
        <button @click="props.onClose" class="nav-icon-btn" title="关闭 (ESC)">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <div class="navbar-divider"></div>
        <div class="navbar-counter">
          <span class="counter-current">{{ props.currentIndex + 1 }}</span>
          <span class="counter-separator">/</span>
          <span class="counter-total">{{ props.entries.length }}</span>
        </div>
      </div>

      <div class="navbar-center">
        <button
          v-if="props.onPrev && props.currentIndex > 0"
          @click="props.onPrev"
          class="nav-icon-btn"
          title="上一张 (←)"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <button
          v-if="props.onNext && props.currentIndex < props.entries.length - 1"
          @click="props.onNext"
          class="nav-icon-btn"
          title="下一张 (→)"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

      <div class="navbar-right">
        <button @click="openPhotoSwipe" class="nav-icon-btn" title="全屏查看">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path
              d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"
            />
          </svg>
        </button>
      </div>
    </div>

    <!-- 复制成功提示 -->
    <transition name="slide-fade">
      <div v-if="copySuccess" class="notification-toast">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <span>已复制{{ copySuccess }}</span>
      </div>
    </transition>

    <!-- 主内容区域 -->
    <div class="main-content">
      <!-- 图片展示区 -->
      <div class="image-display">
        <div class="image-container" @click="openPhotoSwipe">
          <img
            :src="currentEntry.src"
            :alt="currentEntry.prompt"
            class="main-image"
          />
          <div class="image-overlay">
            <div class="overlay-hint">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
                <path d="M11 8v6M8 11h6" />
              </svg>
              <span>点击放大查看</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 右侧：信息面板 -->
      <div class="info-panel">
        <div class="info-scroll">
          <!-- 头部工具栏 -->
          <div class="panel-toolbar">
            <div class="toolbar-left">
              <div class="toolbar-title">Details</div>
              <div class="toolbar-subtitle">
                {{ props.currentIndex + 1 }} of {{ props.entries.length }}
              </div>
            </div>
            <div class="toolbar-right">
              <button
                v-if="hasSelectableTags"
                @click="toggleMultiSelect"
                :class="['icon-btn', { active: isMultiSelectMode }]"
                title="多选模式"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <path d="M9 11l3 3L22 4" />
                  <path
                    d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"
                  />
                </svg>
              </button>
              <button
                v-if="isMultiSelectMode && hasSelectableTags"
                @click="copySelected"
                :class="['icon-btn', 'success']"
                :disabled="selectedTags.length === 0"
                :title="`复制选中 (${selectedTags.length})`"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path
                    d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"
                  />
                </svg>
              </button>
              <button
                @click="copyAllInfo"
                class="icon-btn"
                title="复制全部信息"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <path
                    d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"
                  />
                  <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
                </svg>
              </button>
            </div>
          </div>

          <!-- 正向提示词 -->
          <div class="content-section" v-if="promptDisplay.text">
            <div class="section-title">
              <div class="title-bar positive"></div>
              <span>Positive Prompt</span>
              <button
                @click="copyToClipboard(currentEntry.prompt, '提示词')"
                class="mini-btn"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path
                    d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"
                  />
                </svg>
              </button>
            </div>
            <div v-if="promptDisplay.isLongText" class="prompt-text-box positive">
              <div class="prompt-text-meta">
                <span class="prompt-text-badge">Long Prompt</span>
                <span class="prompt-text-hint">Select any part, or copy the full text.</span>
              </div>
              <pre class="prompt-text-content">{{ promptDisplay.text }}</pre>
            </div>
            <div v-else class="tags-wrapper">
              <span
                v-for="(tag, index) in promptTags"
                :key="index"
                :class="[
                  'tag-chip positive',
                  { selected: selectedTags.includes(tag) }
                ]"
                @click="handleTagClick(tag)"
                :title="isMultiSelectMode ? '点击选择/取消' : '点击复制'"
              >
                {{ tag }}
              </span>
            </div>
          </div>

          <!-- 负向提示词 -->
          <div class="content-section" v-if="negativePromptDisplay.text">
            <div class="section-title">
              <div class="title-bar negative"></div>
              <span>Negative Prompt</span>
              <button
                @click="copyToClipboard(negativePrompt, '反向提示词')"
                class="mini-btn"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path
                    d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"
                  />
                </svg>
              </button>
            </div>
            <div v-if="negativePromptDisplay.isLongText" class="prompt-text-box negative">
              <div class="prompt-text-meta">
                <span class="prompt-text-badge">Long Prompt</span>
                <span class="prompt-text-hint">Select any part, or copy the full text.</span>
              </div>
              <pre class="prompt-text-content">{{ negativePromptDisplay.text }}</pre>
            </div>
            <div v-else class="tags-wrapper">
              <span
                v-for="(tag, index) in negativePromptTags"
                :key="index"
                :class="[
                  'tag-chip negative',
                  { selected: selectedTags.includes(tag) }
                ]"
                @click="handleTagClick(tag)"
                :title="isMultiSelectMode ? '点击选择/取消' : '点击复制'"
              >
                {{ tag }}
              </span>
            </div>
          </div>

          <!-- 生成参数 -->
          <div class="content-section" v-if="metaLines.length">
            <div class="section-title">
              <div class="title-bar info"></div>
              <span>Generation Parameters</span>
            </div>
            <div class="params-list">
              <div class="param-row" v-for="(item, i) in metaLines" :key="i">
                <span class="param-label">{{ item.label }}</span>
                <span class="param-value">{{ item.value }}</span>
              </div>
            </div>
          </div>

          <!-- 时间戳 -->
          <div
            class="content-section timestamp-section"
            v-if="currentEntry.timestamp"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <span>{{
              new Date(currentEntry.timestamp).toLocaleString("zh-CN")
            }}</span>
          </div>

          <!-- 快速操作 -->
          <div
            class="quick-actions"
            v-if="props.onRefresh || canDownloadOriginal"
          >
            <button
              v-if="props.onRefresh"
              @click="props.onRefresh"
              class="quick-action-btn"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
              </svg>
              <span>刷新图片</span>
            </button>
            <button
              v-if="canDownloadOriginal"
              @click="downloadOriginalImage"
              class="quick-action-btn download"
              :disabled="isDownloading"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <span>{{ isDownloading ? "下载中..." : "下载原图" }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ========== 基础容器 ========== */
.viewer-container {
  position: fixed;
  inset: 0;
  background: var(--bg-primary);
  z-index: 1000;
  display: flex;
  flex-direction: column;
  animation: fadeIn 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

/* ========== 顶部导航栏 ========== */
.top-navbar {
  position: relative;
  height: 3.5rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 1rem;
  background: var(--bg-secondary);
  backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--border-color);
  z-index: 100;
  flex-shrink: 0;
}

.navbar-left,
.navbar-center,
.navbar-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.navbar-left {
  flex: 1;
}

.navbar-right {
  flex: 1;
  justify-content: flex-end;
}

.navbar-center {
  gap: 0.5rem;
}

.navbar-divider {
  width: 1px;
  height: 1.5rem;
  background: var(--border-color);
}

.navbar-counter {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  font-size: 0.875rem;
  line-height: 1;
}

.counter-current {
  font-weight: 700;
  font-size: 1.125rem;
  color: var(--text-primary);
}

.counter-separator {
  color: var(--text-muted);
  font-weight: 500;
}

.counter-total {
  color: var(--text-secondary);
  font-weight: 500;
}

.nav-icon-btn {
  width: 2.25rem;
  height: 2.25rem;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 0.5rem;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.nav-icon-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.nav-icon-btn:active {
  transform: scale(0.95);
}

/* ========== 通知提示 ========== */
.notification-toast {
  position: fixed;
  top: 5rem;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(16, 185, 129, 0.95);
  backdrop-filter: blur(10px);
  color: white;
  padding: 0.75rem 1.25rem;
  border-radius: 0.75rem;
  font-weight: 600;
  font-size: 0.875rem;
  box-shadow: 0 8px 16px rgba(16, 185, 129, 0.3);
  z-index: 1001;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.slide-fade-enter-active {
  animation: slideDown 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.slide-fade-leave-active {
  animation: slideUp 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes slideDown {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(-20px);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}

@keyframes slideUp {
  to {
    opacity: 0;
    transform: translateX(-50%) translateY(-10px);
  }
}

/* ========== 主内容区域 ========== */
.main-content {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}

/* ========== 图片展示区 ========== */
.image-display {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  min-width: 0;
  overflow: hidden;
}

.image-container {
  position: relative;
  max-width: 100%;
  max-height: 100%;
  cursor: zoom-in;
  border-radius: 0.75rem;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.image-container:hover {
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.18);
  transform: scale(1.01);
}

.image-container:hover .image-overlay {
  opacity: 1;
}

.main-image {
  display: block;
  max-width: 100%;
  max-height: calc(100vh - 7.5rem);
  width: auto;
  height: auto;
  object-fit: contain;
}

.image-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to top,
    rgba(0, 0, 0, 0.6) 0%,
    rgba(0, 0, 0, 0) 50%
  );
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 2rem;
  opacity: 0;
  transition: opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.overlay-hint {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: white;
  font-size: 0.875rem;
  font-weight: 600;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(10px);
  padding: 0.625rem 1rem;
  border-radius: 0.625rem;
}

.overlay-hint svg {
  flex-shrink: 0;
}

/* ========== 信息面板 ========== */
.info-panel {
  width: 420px;
  background: var(--bg-secondary);
  border-left: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  overflow: hidden;
}

.info-scroll {
  overflow-y: auto;
  height: 100%;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}

/* ========== 工具栏样式 ========== */
.panel-toolbar {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--bg-secondary);
  backdrop-filter: blur(10px);
  padding: 1.25rem;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
}

.toolbar-left {
  flex: 1;
  min-width: 0;
}

.toolbar-title {
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 0.25rem;
  letter-spacing: -0.02em;
}

.toolbar-subtitle {
  font-size: 0.75rem;
  color: var(--text-muted);
  font-weight: 500;
}

.toolbar-right {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.icon-btn {
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: none;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  border-radius: 0.5rem;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.icon-btn:hover {
  background: var(--bg-primary);
  color: var(--text-primary);
  transform: translateY(-1px);
}

.icon-btn.active {
  background: var(--primary);
  color: white;
}

.icon-btn.success {
  background: #10b981;
  color: white;
}

.icon-btn.success:hover {
  background: #059669;
}

.icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  transform: none;
}

/* 内容区域 */
.content-section {
  padding: 1.25rem;
  border-bottom: 1px solid var(--border-color);
  animation: fadeInUp 0.4s ease backwards;
}

.content-section:nth-child(2) {
  animation-delay: 0.05s;
}
.content-section:nth-child(3) {
  animation-delay: 0.1s;
}
.content-section:nth-child(4) {
  animation-delay: 0.15s;
}
.content-section:nth-child(5) {
  animation-delay: 0.2s;
}

@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.section-title {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  margin-bottom: 1rem;
  font-size: 0.813rem;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.01em;
}

.title-bar {
  width: 3px;
  height: 1rem;
  border-radius: 3px;
  flex-shrink: 0;
}

.title-bar.positive {
  background: linear-gradient(180deg, #3b82f6 0%, #2563eb 100%);
}

.title-bar.negative {
  background: linear-gradient(180deg, #ef4444 0%, #dc2626 100%);
}

.title-bar.info {
  background: linear-gradient(180deg, #8b5cf6 0%, #7c3aed 100%);
}

.mini-btn {
  margin-left: auto;
  padding: 0.25rem 0.5rem;
  border: none;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  border-radius: 0.375rem;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.mini-btn:hover {
  background: var(--primary);
  color: white;
  transform: scale(1.05);
}

.prompt-text-box {
  padding: 0.95rem 1rem 1rem;
  border-radius: 0.875rem;
  border: 1px solid transparent;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

.prompt-text-box.positive {
  background:
    linear-gradient(180deg, rgba(59, 130, 246, 0.12) 0%, rgba(59, 130, 246, 0.04) 100%),
    var(--bg-tertiary);
  border-color: rgba(59, 130, 246, 0.16);
}

.prompt-text-box.negative {
  background:
    linear-gradient(180deg, rgba(239, 68, 68, 0.12) 0%, rgba(239, 68, 68, 0.04) 100%),
    var(--bg-tertiary);
  border-color: rgba(239, 68, 68, 0.16);
}

.prompt-text-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}

.prompt-text-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.25rem 0.55rem;
  border-radius: 999px;
  font-size: 0.688rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.prompt-text-box.positive .prompt-text-badge {
  background: rgba(59, 130, 246, 0.14);
  color: #1d4ed8;
}

.prompt-text-box.negative .prompt-text-badge {
  background: rgba(239, 68, 68, 0.14);
  color: #b91c1c;
}

.prompt-text-hint {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.prompt-text-content {
  margin: 0;
  font-family: inherit;
  font-size: 0.875rem;
  line-height: 1.75;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
  cursor: text;
}

/* 标签容器 */
.tags-wrapper {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.tag-chip {
  padding: 0.375rem 0.75rem;
  border-radius: 0.5rem;
  font-size: 0.813rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  line-height: 1.4;
  letter-spacing: -0.01em;
  user-select: none;
}

.tag-chip.positive {
  background: rgba(59, 130, 246, 0.08);
  color: #2563eb;
  border: 1px solid rgba(59, 130, 246, 0.15);
}

.tag-chip.positive:hover {
  background: rgba(59, 130, 246, 0.15);
  border-color: rgba(59, 130, 246, 0.3);
  transform: translateY(-1px);
}

.tag-chip.negative {
  background: rgba(239, 68, 68, 0.08);
  color: #dc2626;
  border: 1px solid rgba(239, 68, 68, 0.15);
}

.tag-chip.negative:hover {
  background: rgba(239, 68, 68, 0.15);
  border-color: rgba(239, 68, 68, 0.3);
  transform: translateY(-1px);
}

.tag-chip.selected {
  background: var(--primary) !important;
  color: white !important;
  border-color: var(--primary) !important;
  transform: translateY(-2px);
  box-shadow: 0 4px 8px rgba(var(--primary-rgb, 99, 102, 241), 0.25);
}

/* 参数列表 */
.params-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.param-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 0.625rem 0.875rem;
  background: var(--bg-tertiary);
  border-radius: 0.5rem;
  gap: 1rem;
  transition: all 0.2s ease;
}

.param-row:hover {
  background: var(--bg-primary);
  transform: translateX(2px);
}

.param-label {
  font-size: 0.813rem;
  color: var(--text-secondary);
  font-weight: 500;
  flex-shrink: 0;
}

.param-value {
  font-size: 0.875rem;
  color: var(--text-primary);
  font-weight: 600;
  text-align: right;
  word-break: break-word;
}

/* 时间戳样式 */
.timestamp-section {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem !important;
  font-size: 0.75rem;
  color: var(--text-muted);
  font-weight: 500;
}

/* 快速操作 */
.quick-actions {
  padding: 1rem 1.25rem;
  display: flex;
  gap: 0.625rem;
}

.quick-action-btn {
  flex: 1;
  padding: 0.75rem 1rem;
  border: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border-radius: 0.625rem;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
}

.quick-action-btn:hover {
  background: var(--primary);
  color: white;
  border-color: var(--primary);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(var(--primary-rgb, 99, 102, 241), 0.2);
}

/* ========== 响应式设计 ========== */
.quick-action-btn.download:hover {
  background: #0ea5e9;
  border-color: #0ea5e9;
}

@media (max-width: 1024px) {
  .main-content {
    flex-direction: column;
  }

  .image-display {
    flex: 0 0 auto;
    padding: 1rem;
    max-height: 50vh;
  }

  .main-image {
    max-height: 45vh;
  }

  .info-panel {
    width: 100%;
    border-left: none;
    border-top: 1px solid var(--border-color);
    flex: 1;
    border-radius: 1rem 1rem 0 0;
  }

  .panel-toolbar {
    padding: 1rem;
  }

  .toolbar-title {
    font-size: 1rem;
  }

  .content-section {
    padding: 1rem;
  }

  .quick-actions {
    padding: 0.75rem 1rem;
  }
}

@media (max-width: 640px) {
  .top-navbar {
    padding: 0 0.75rem;
  }

  .navbar-divider {
    display: none;
  }

  .image-display {
    padding: 0.75rem;
  }

  .navbar-center {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
  }
}

/* ========== 滚动条样式 ========== */
.info-scroll::-webkit-scrollbar {
  width: 6px;
}

.info-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.info-scroll::-webkit-scrollbar-thumb {
  background: var(--border-color);
  border-radius: 3px;
}

.info-scroll::-webkit-scrollbar-thumb:hover {
  background: var(--text-muted);
}
</style>
