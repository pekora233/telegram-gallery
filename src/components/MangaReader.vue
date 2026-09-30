<script setup>
import { computed, inject, onMounted, onUnmounted, ref, watch } from "vue";
import MangaViewer from "@tokagemushi/manga-viewer";
import { getImageBlob } from "../utils/galleryDB.js";

const props = defineProps({
  entries: { type: Array, default: () => [] },
  currentIndex: { type: Number, default: 0 },
  onSetIndex: Function,
  onNeedMore: Function
});
const emit = defineEmits(["close"]);
const theme = inject("theme", ref("light"));
const viewerHost = ref(null);
const readerRoot = ref(null);
const readerError = ref("");
const showHelp = ref(false);
const isFullscreen = ref(false);
const sessionKey = `gallery_manga_session_${crypto.randomUUID()}`;
const previousFocus = document.activeElement;
let viewer = null;
let rebuilding = false;
let activeEntryId = null;
let fullscreenRoot = null;
let renderGeneration = 0;
let disposed = false;
const imageSourceLoads = new Map();
const ownedImageUrls = new Set();

function readPreference(key, allowed, fallback) {
  try {
    const saved = localStorage.getItem(key);
    return allowed.includes(saved) ? saved : fallback;
  } catch {
    return fallback;
  }
}

const direction = ref(readPreference("gallery_manga_direction", ["rtl", "ltr"], "rtl"));
const viewMode = ref(readPreference("gallery_manga_mode", ["page", "scroll"], "page"));
const pages = computed(() => props.entries.flatMap((entry, entryIndex) => {
  const fileId = entry?.telegram?.file_id_lossy || entry?.telegram?.file_id;
  const format = entry?.telegram?.file_id_lossy
    ? entry.telegram.file_id_lossy_format
    : entry?.telegram?.file_id_format;
  const filename = format ? `image.${format}` : "image";
  const reusableSource = /^(blob:|data:)/.test(entry?.src || "")
    && (!entry.displayFileId || entry.displayFileId === fileId);
  const src = reusableSource ? entry.src : fileId ? `/api/file/${encodeURIComponent(fileId)}/${filename}` : entry?.src;
  const width = Number(entry?.metadata?.width);
  const height = Number(entry?.metadata?.height);
  return src ? [{
    id: entry.id,
    fileId,
    entryIndex,
    src,
    width: Number.isFinite(width) && width > 0 ? width : 1200,
    height: Number.isFinite(height) && height > 0 ? height : 1600
  }] : [];
}));

const messages = {
  pageAnnounce: (pageNumber, total) => `第 ${pageNumber} 页，共 ${total} 页`,
  ariaPrevPage: "上一页",
  ariaNextPage: "下一页"
};

function clearSessionProgress() {
  try {
    localStorage.removeItem(sessionKey);
  } catch {}
}

function notifyPageChange(pageNumber) {
  if (rebuilding) return;
  const page = pages.value[pageNumber - 1];
  if (!page) return;
  activeEntryId = page.id;
  if (page.entryIndex !== props.currentIndex) {
    props.onSetIndex?.(page.entryIndex);
  }
  if (props.entries.length - 1 - page.entryIndex <= 5) {
    props.onNeedMore?.(page.entryIndex);
  }
}

function resolveImageSource(page) {
  if (!page.fileId || /^(blob:|data:)/.test(page.src)) return Promise.resolve(page.src);
  if (imageSourceLoads.has(page.fileId)) return imageSourceLoads.get(page.fileId);

  const sourceLoad = (async () => {
    try {
      const blob = await getImageBlob(page.fileId);
      if (blob && !disposed) {
        const source = URL.createObjectURL(blob);
        ownedImageUrls.add(source);
        return source;
      }
    } catch {}
    imageSourceLoads.delete(page.fileId);
    return page.src;
  })();
  imageSourceLoads.set(page.fileId, sourceLoad);
  return sourceLoad;
}

async function rebuildViewer() {
  if (!viewerHost.value) return;
  const generation = ++renderGeneration;
  const currentPages = pages.value;
  const imageSources = await Promise.all(currentPages.map(resolveImageSource));
  if (disposed || generation !== renderGeneration || currentPages !== pages.value || !viewerHost.value) return;
  const previousPage = viewer?.currentPage || 1;
  rebuilding = true;
  viewer?.destroy();
  viewer = null;
  clearSessionProgress();
  readerError.value = "";

  if (pages.value.length === 0) {
    readerError.value = "当前列表没有可阅读的图片，请返回图库选择图片。";
    rebuilding = false;
    return;
  }

  const activeIndex = activeEntryId == null ? -1 : pages.value.findIndex((page) => page.id === activeEntryId);
  const selectedPage = pages.value.findIndex((page) => page.entryIndex === props.currentIndex);
  const targetPage = activeIndex >= 0 ? activeIndex + 1 : selectedPage >= 0 ? selectedPage + 1 : previousPage;

  try {
    viewer = new MangaViewer({
      container: viewerHost.value,
      pages: imageSources,
      direction: direction.value,
      viewMode: viewMode.value,
      theme: theme.value,
      showHeader: false,
      bookmarkId: sessionKey,
      storageKey: sessionKey,
      loadingText: "正在加载漫画…",
      messages,
      onPageChange: notifyPageChange
    });
    const style = document.createElement("style");
    style.textContent = `
      .mv-container { position: absolute; height: 100%; }
      .mv-scroll-mode, .mv-scroll-mode .mv-zoom-container { touch-action: pan-y pinch-zoom; }
      .mv-scroll-mode .mv-tap-area { display: none; }
    `;
    viewerHost.value.shadowRoot.appendChild(style);
    const pagesBySource = new Map(currentPages.map((page, index) => [imageSources[index], page]));
    viewerHost.value.shadowRoot.querySelectorAll(".mv-page-slot img").forEach((image) => {
      const page = pagesBySource.get(image.getAttribute("src"));
      if (!page) return;
      image.setAttribute("width", String(page.width));
      image.setAttribute("height", String(page.height));
    });
    viewer.goToPage(Math.min(targetPage, pages.value.length));
    if (viewMode.value === "scroll") {
      const target = viewerHost.value.shadowRoot.querySelector(`[data-slot="${viewer.currentPage - 1}"]`);
      target?.scrollIntoView({ behavior: "instant", block: "start" });
    }
    const slider = viewerHost.value.shadowRoot.querySelector('[role="slider"]');
    slider?.setAttribute("aria-label", "阅读进度");
    const zoomButtons = viewerHost.value.shadowRoot.querySelectorAll(".mv-zoom-btn");
    zoomButtons.forEach((button, index) => {
      const label = index === 0 ? "放大" : "重置缩放";
      button.title = label;
      button.setAttribute("aria-label", label);
    });
  } catch (error) {
    readerError.value = "漫画阅读器加载失败，请返回后重试。";
    console.error("Failed to initialize manga reader:", error);
  } finally {
    rebuilding = false;
  }
  if (viewer) notifyPageChange(viewer.currentPage);
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement === readerRoot.value) {
      await document.exitFullscreen();
    } else {
      await readerRoot.value.requestFullscreen();
    }
  } catch {
    readerError.value = "此浏览器不支持全屏，仍可正常阅读。";
  }
}

function updateFullscreen() {
  isFullscreen.value = document.fullscreenElement === readerRoot.value;
}

function handleKeydown(event) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  if (showHelp.value) showHelp.value = false;
  else emit("close");
}

watch([direction, viewMode], () => {
  try {
    localStorage.setItem("gallery_manga_direction", direction.value);
    localStorage.setItem("gallery_manga_mode", viewMode.value);
  } catch {}
});
watch([pages, direction, viewMode, theme], rebuildViewer, { flush: "post" });
watch(() => props.currentIndex, (index) => {
  if (!viewer || rebuilding) return;
  const target = pages.value.findIndex((page) => page.entryIndex === index);
  if (target < 0 || pages.value[viewer.currentPage - 1]?.entryIndex === index) return;
  activeEntryId = pages.value[target].id;
  viewer.goToPage(target + 1);
});

onMounted(() => {
  fullscreenRoot = readerRoot.value;
  rebuildViewer();
  document.addEventListener("fullscreenchange", updateFullscreen);
});

onUnmounted(() => {
  disposed = true;
  renderGeneration += 1;
  if (document.fullscreenElement === fullscreenRoot) {
    void document.exitFullscreen().catch(() => {});
  }
  viewer?.destroy();
  ownedImageUrls.forEach((source) => URL.revokeObjectURL(source));
  ownedImageUrls.clear();
  clearSessionProgress();
  document.removeEventListener("fullscreenchange", updateFullscreen);
  previousFocus?.focus({ preventScroll: true });
});
</script>

<template>
  <Teleport to="body">
    <section ref="readerRoot" class="manga-reader" role="dialog" aria-modal="true" aria-label="漫画阅读" @keydown="handleKeydown">
      <header class="reader-toolbar">
        <button class="reader-button" aria-label="返回图片详情" title="返回图片详情 (Esc)" @click="emit('close')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M19 12H5m7-7-7 7 7 7" />
          </svg>
          <span>返回</span>
        </button>
        <div class="reader-heading">
          <h2>漫画阅读</h2>
          <span>按图库当前顺序阅读</span>
        </div>
        <div class="reader-settings">
          <select v-model="direction" aria-label="阅读方向">
            <option value="rtl">从右向左</option>
            <option value="ltr">从左向右</option>
          </select>
          <select v-model="viewMode" aria-label="阅读模式">
            <option value="page">翻页模式</option>
            <option value="scroll">竖向滚动</option>
          </select>
          <button class="reader-button" :aria-label="isFullscreen ? '退出全屏' : '全屏阅读'" :title="isFullscreen ? '退出全屏' : '全屏阅读'" @click="toggleFullscreen">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5" />
            </svg>
          </button>
          <button class="reader-button" aria-label="操作说明" :aria-expanded="showHelp" @click="showHelp = !showHelp">?</button>
        </div>
      </header>
      <aside v-if="showHelp" class="reader-help">
        <strong>操作说明</strong>
        <p>左右滑动或使用方向键翻页，空格翻到下一页；双击或双指缩放。横屏自动显示双页。</p>
        <p>竖向滚动适合长条漫画。底部滑块可跳页，Esc 返回图片详情。图片顺序跟随图库，可先切换正序。</p>
      </aside>
      <div v-if="readerError" class="reader-error" role="alert">{{ readerError }}</div>
      <div ref="viewerHost" class="reader-host" aria-label="漫画页面"></div>
    </section>
  </Teleport>
</template>

<style scoped>
.manga-reader {
  position: fixed;
  inset: 0;
  z-index: 11000;
  display: flex;
  flex-direction: column;
  height: 100dvh;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.reader-toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 16px;
  padding-top: max(10px, env(safe-area-inset-top));
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

.reader-heading { flex: 1; min-width: 0; }
.reader-heading h2 { font-size: 16px; }
.reader-heading span { color: var(--text-secondary); font-size: 12px; }
.reader-settings { display: flex; align-items: center; gap: 8px; }
.reader-settings select { width: auto; font-size: 14px; }

.reader-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 36px;
  min-height: 36px;
  padding: 6px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  font-size: 14px;
}

.reader-button:hover { background: var(--border-color); }
.reader-button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.reader-help, .reader-error { padding: 12px 16px; border-bottom: 1px solid var(--border-color); font-size: 14px; }
.reader-help { background: var(--bg-secondary); }
.reader-help p { margin-top: 6px; color: var(--text-secondary); }
.reader-error { color: var(--danger); }
.reader-host { flex: 1; min-height: 0; position: relative; transform: translateZ(0); }

@media (max-width: 600px) {
  .reader-toolbar { flex-wrap: wrap; gap: 8px; padding-inline: 12px; }
  .reader-settings { width: 100%; }
  .reader-settings select { flex: 1; min-width: 0; }
}
</style>
