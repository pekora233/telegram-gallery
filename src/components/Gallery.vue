<script setup>
import { ref, onMounted, onUnmounted, computed, inject, nextTick, watch } from "vue";
import ImageDetail from "./ImageDetail.vue";
import {
  putItems, getAllItems, deleteItem as dbDeleteItem, isAvailable as isIDBAvailable,
  putImageBlob, getImageBlob, deleteImageBlob, clearAll, clearImageBlobs,
} from "../utils/galleryDB.js";

const useIDB = isIDBAvailable();

const token = localStorage.getItem("gallery_token");
const entries = ref([]);
const loading = ref(false);
const error = ref("");
const selectedIndex = ref(-1);
let pollTimer = null;
let loadMoreObserver = null;
let renderMoreObserver = null;
const loadMoreAnchor = ref(null);
const renderMoreAnchor = ref(null);
const loadingMore = ref(false);
const hasMore = ref(true);
const RENDER_BATCH = 40;
const renderCount = ref(RENDER_BATCH);
const paginationCursor = ref(null);
const PAGE_SIZE = 60;
const pendingImageLoads = new Set();
const queuedImageFileIds = new Set();
const imageLoadQueue = [];
let activeImageLoadCount = 0;
const MAX_CONCURRENT_IMAGE_LOADS = 4;
const IMAGE_CACHE_MAX_ITEMS = 300;
const TAG_PARSE_CACHE_MAX_ITEMS = 1500;
const parsedTagCache = new Map();
const ROOT_BACK_EXIT_WINDOW_MS = 1500;
const DETAIL_AUTO_LOAD_THRESHOLD = 5;
let lastRootBackAt = 0;
let hasDetailHistoryState = false;
let suppressNextPopstate = false;

// Retry wrapper for fetch — retries on network errors and 5xx responses
async function fetchWithRetry(input, init, { retries = 2, delay = 300 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(input, init);
      // Retry on 5xx server errors (likely transient Worker/DB issues)
      if (resp.status >= 500 && attempt < retries) {
        await new Promise((r) => setTimeout(r, delay * (attempt + 1)));
        continue;
      }
      return resp;
    } catch (e) {
      lastError = e;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delay * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

// 显示模式：desc（倒序/默认）、asc（正序）、pagination（分页）、categories（分类）
const DISPLAY_MODES = new Set(['desc', 'asc', 'pagination', 'categories']);
const savedDisplayMode = localStorage.getItem('gallery_display_mode');
const displayMode = ref(DISPLAY_MODES.has(savedDisplayMode) ? savedDisplayMode : 'desc');
const PAGINATION_VIEW_SIZE = 60;
const PAGINATION_PREFETCH_PAGES = 10;
const paginationPage = ref(1);
const paginationJumpInput = ref("");
const paginationTotalCount = ref(0);
const paginationTotalPages = ref(1);
const paginationPageCache = new Map();
const PAGINATION_CACHE_MAX_PAGES = 30;
const paginationBatchRequests = new Map();
let paginationBatchEndCursor = null;
let paginationLastBatchEndPage = 0;

// 分类数据
const categoriesData = ref([]);
const categoriesLoading = ref(false);
const expandedCatId = ref(null);
const categoryImages = ref({});

// 从 App 提供的 theme 注入
const theme = inject('theme', ref('light'));
const toggleTheme = inject('toggleTheme', null);
const setView = inject('setView', null);

function logout() {
  localStorage.removeItem("gallery_token");
  location.reload();
}

// 删除模态与提示
const showDeleteModal = ref(false);
const pendingDelete = ref(null);
const showClearCacheModal = ref(false);
const toastMessage = ref('');
const showToast = ref(false);
const batchMode = ref(false);
const selectedEntryIds = ref([]);
const pendingDeleteIds = new Set();
const selectedCount = computed(() => selectedEntryIds.value.length);
const allEntriesSelected = computed(() => (
  entries.value.length > 0 && selectedEntryIds.value.length === entries.value.length
));

function showToastMsg(message, duration = 2500) {
  toastMessage.value = message;
  showToast.value = true;
  setTimeout(() => {
    showToast.value = false;
    toastMessage.value = '';
  }, duration);
}

function syncSelectionWithEntries() {
  const visibleIds = new Set(entries.value.map((entry) => entry.id));
  selectedEntryIds.value = selectedEntryIds.value.filter((id) => visibleIds.has(id));
}

function toggleBatchMode() {
  batchMode.value = !batchMode.value;
  selectedIndex.value = -1;
  if (!batchMode.value) {
    selectedEntryIds.value = [];
  }
}

function isEntrySelected(entryId) {
  return selectedEntryIds.value.includes(entryId);
}

function toggleEntrySelection(entryId) {
  if (!entryId) return;
  if (isEntrySelected(entryId)) {
    selectedEntryIds.value = selectedEntryIds.value.filter((id) => id !== entryId);
  } else {
    selectedEntryIds.value = [...selectedEntryIds.value, entryId];
  }
}

function clearBatchSelection() {
  selectedEntryIds.value = [];
}

function toggleSelectAllEntries() {
  if (allEntriesSelected.value) {
    clearBatchSelection();
    return;
  }
  selectedEntryIds.value = entries.value.map((entry) => entry.id);
}

function openDeleteModal(entry) {
  pendingDelete.value = entry;
  showDeleteModal.value = true;
}

function cancelDelete() {
  pendingDelete.value = null;
  showDeleteModal.value = false;
}

async function performDelete() {
  const entry = pendingDelete.value;
  if (!entry || !entry.id) return;
  showDeleteModal.value = false;

  const snapshot = hideEntryOptimistically(entry.id);

  try {
    await requestDeleteById(entry.id);
    finalizeDeleteSuccess(entry);
    showToastMsg('已删除');
  } catch (e) {
    console.error('Delete failed', e);
    restoreHiddenEntry(snapshot);
    showToastMsg('删除失败: ' + String(e.message || e), 3500);
  } finally {
    pendingDelete.value = null;
  }
}

async function performBatchDelete() {
  const targetEntries = entries.value.filter((entry) => selectedEntryIds.value.includes(entry.id));
  if (targetEntries.length === 0) {
    showToastMsg('请先选择要删除的图片');
    return;
  }

  const ok = window.confirm(`确定要删除选中的 ${targetEntries.length} 张图片吗？此操作不可恢复。`);
  if (!ok) return;

  const targets = targetEntries.map((entry) => ({
    entry,
    snapshot: hideEntryOptimistically(entry.id)
  }));

  selectedEntryIds.value = [];
  batchMode.value = false;

  let successCount = 0;
  let failCount = 0;

  for (const target of targets) {
    try {
      await requestDeleteById(target.entry.id);
      finalizeDeleteSuccess(target.entry);
      successCount += 1;
    } catch (e) {
      console.error('Batch delete failed', e);
      restoreHiddenEntry(target.snapshot);
      failCount += 1;
    }
  }

  if (failCount === 0) {
    showToastMsg(`已删除 ${successCount} 张图片`);
  } else {
    showToastMsg(`已删除 ${successCount} 张，${failCount} 张删除失败`, 3500);
  }
}

// 图片缓存管理（永久缓存）
const IMAGE_CACHE_KEY = 'gallery_image_cache';
const GALLERY_LIST_CACHE_KEY = 'gallery_list_cache';
const LOCAL_STORAGE_CACHE_KEYS = [
  IMAGE_CACHE_KEY,
  GALLERY_LIST_CACHE_KEY,
];

function clearLocalStorageCaches() {
  const keysToRemove = new Set(LOCAL_STORAGE_CACHE_KEYS);

  // Also clear legacy cache keys that follow gallery_*_cache.
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && key.startsWith('gallery_') && key.endsWith('_cache')) {
      keysToRemove.add(key);
    }
  }

  keysToRemove.forEach((key) => {
    localStorage.removeItem(key);
  });
}

function normalizeImageCache(cache) {
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) {
    return {};
  }

  const normalized = {};
  Object.entries(cache).forEach(([fileId, item]) => {
    if (!fileId || !item || typeof item.url !== 'string' || !item.url) return;
    normalized[fileId] = {
      url: item.url,
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
    };
  });
  return normalized;
}

function pruneImageCache(cache, maxItems = IMAGE_CACHE_MAX_ITEMS) {
  const keys = Object.keys(cache);
  if (keys.length <= maxItems) return cache;

  const keepKeys = keys
    .sort((a, b) => (cache[b]?.updatedAt || 0) - (cache[a]?.updatedAt || 0))
    .slice(0, maxItems);

  const trimmed = {};
  keepKeys.forEach((key) => {
    trimmed[key] = cache[key];
  });
  return trimmed;
}

function persistImageCache(cache) {
  const normalized = pruneImageCache(normalizeImageCache(cache));
  try {
    localStorage.setItem(IMAGE_CACHE_KEY, JSON.stringify(normalized));
    return normalized;
  } catch (e) {
    // If quota is exceeded, keep only half of the newest entries and retry once.
    const fallback = pruneImageCache(normalized, Math.max(50, Math.floor(IMAGE_CACHE_MAX_ITEMS / 2)));
    try {
      localStorage.setItem(IMAGE_CACHE_KEY, JSON.stringify(fallback));
      return fallback;
    } catch (err) {
      console.error('Failed to persist image cache:', err);
      return {};
    }
  }
}

function getImageCache() {
  try {
    const cache = localStorage.getItem(IMAGE_CACHE_KEY);
    return normalizeImageCache(cache ? JSON.parse(cache) : {});
  } catch (e) {
    return {};
  }
}

function setImageCache(fileId, url) {
  if (!fileId || !url) return;
  try {
    const cache = getImageCache();
    cache[fileId] = { url, updatedAt: Date.now() };
    persistImageCache(cache);
  } catch (e) {
    console.error('Failed to cache image:', e);
  }
}

function buildFileUrl(fileId, ext, withCacheBust = false) {
  const filename = ext ? `image.${ext}` : 'image';
  const base = `/api/file/${encodeURIComponent(fileId)}/${filename}`;
  if (withCacheBust) {
    return `${base}?t=${Date.now()}`;
  }
  return base;
}

function getDisplayFileId(entry) {
  return entry?.telegram?.file_id_lossy || entry?.telegram?.file_id || null;
}

function getDisplayFormat(entry) {
  if (entry?.telegram?.file_id_lossy && entry?.telegram?.file_id_lossy_format) {
    return entry.telegram.file_id_lossy_format;
  }
  return entry?.telegram?.file_id_format || null;
}

function getGalleryListCache() {
  try {
    const cache = localStorage.getItem(GALLERY_LIST_CACHE_KEY);
    return cache ? JSON.parse(cache) : null;
  } catch (e) {
    return null;
  }
}

function setGalleryListCache(list) {
  try {
    // 仅缓存首屏，避免本地缓存过大
    const topList = Array.isArray(list) ? list.slice(0, PAGE_SIZE) : [];
    localStorage.setItem(GALLERY_LIST_CACHE_KEY, JSON.stringify(topList));
  } catch (e) {
    console.error('Failed to cache gallery list:', e);
  }
}

function removeEntryFromLocalCache(entry) {
  const cached = getGalleryListCache() || [];
  setGalleryListCache(cached.filter((item) => item.id !== entry.id));

  try {
    const imageCache = getImageCache();
    const fileIds = [
      entry?.displayFileId,
      entry?.telegram?.file_id_lossy,
      entry?.telegram?.file_id,
    ].filter(Boolean);

    fileIds.forEach((fileId) => {
      if (imageCache[fileId]) {
        delete imageCache[fileId];
      }
    });

    if (fileIds.length > 0) {
      persistImageCache(imageCache);
    }
  } catch (e) {
    // ignore cache cleanup errors
  }
}

function hideEntryOptimistically(entryId) {
  const index = entries.value.findIndex((entry) => entry.id === entryId);
  if (index < 0) return null;

  const [entry] = entries.value.splice(index, 1);

  if (selectedIndex.value === index) {
    selectedIndex.value = -1;
  } else if (selectedIndex.value > index) {
    selectedIndex.value -= 1;
  }

  pendingDeleteIds.add(entryId);
  syncSelectionWithEntries();
  return { entry, index };
}

function restoreHiddenEntry(snapshot) {
  if (!snapshot || !snapshot.entry) return;

  pendingDeleteIds.delete(snapshot.entry.id);
  if (entries.value.some((entry) => entry.id === snapshot.entry.id)) return;

  const insertIndex = Math.min(snapshot.index, entries.value.length);
  entries.value.splice(insertIndex, 0, snapshot.entry);

  if (selectedIndex.value >= insertIndex) {
    selectedIndex.value += 1;
  }
  syncSelectionWithEntries();
}

function finalizeDeleteSuccess(entry) {
  pendingDeleteIds.delete(entry.id);
  if (displayMode.value === 'pagination') {
    clearPaginationPageCache();
    paginationTotalCount.value = Math.max(0, paginationTotalCount.value - 1);
    paginationTotalPages.value = Math.max(1, Math.ceil(paginationTotalCount.value / PAGINATION_VIEW_SIZE));
  }
  removeEntryFromLocalCache(entry);
  if (useIDB) {
    dbDeleteItem(entry.id).catch((e) =>
      console.warn('Failed to delete from IDB:', e)
    );
    const fileId = getDisplayFileId(entry);
    if (fileId) {
      deleteImageBlob(fileId).catch((e) =>
        console.warn('Failed to delete image blob from IDB:', e)
      );
    }
  }
  syncSelectionWithEntries();
}

async function requestDeleteById(entryId) {
  const resp = await fetchWithRetry('/api/gallery', {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ id: entryId })
  });

  let body = null;
  try {
    body = await resp.json();
  } catch (e) {
    body = null;
  }

  if (!resp.ok) {
    throw new Error(body?.error || '删除失败');
  }

  return body;
}

function buildEntryWithCache(entry, existingEntry, imageCache, forceImageRefresh = false) {
  const displayFileId = getDisplayFileId(entry);
  const cachedData = displayFileId && imageCache[displayFileId];
  const keepExistingSrc =
    Boolean(existingEntry?.src) &&
    !forceImageRefresh &&
    existingEntry?.displayFileId === displayFileId;

  let loadingState = false;
  if (forceImageRefresh) {
    loadingState = Boolean(displayFileId);
  } else if (keepExistingSrc) {
    loadingState = false;
  } else if (existingEntry?.loading && !cachedData) {
    loadingState = true;
  } else {
    loadingState = Boolean(displayFileId) && !cachedData;
  }

  return {
    ...existingEntry,
    ...entry,
    displayFileId,
    src: keepExistingSrc ? existingEntry.src : (cachedData && !forceImageRefresh ? cachedData.url : null),
    loading: loadingState,
  };
}

async function fetchGalleryPage(cursor = null, limit = PAGE_SIZE, sort = 'desc') {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  if (sort === 'asc') params.set('sort', 'asc');

  const resp = await fetchWithRetry(`/api/gallery?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  let body = null;
  try {
    body = await resp.json();
  } catch (e) {
    body = null;
  }

  if (!resp.ok) {
    throw new Error(body?.error || 'Failed to load');
  }

  // 兼容后端旧版（数组）
  if (Array.isArray(body)) {
    const items = body;
    return {
      items,
      hasMore: items.length >= limit,
      nextCursor: items.length > 0 ? (items[items.length - 1].timestamp || null) : null,
    };
  }

  return {
    items: Array.isArray(body?.items) ? body.items : [],
    hasMore: Boolean(body?.hasMore),
    nextCursor: body?.nextCursor || null,
  };
}

function getPaginationBatchStart(page = 1, pageSpan = PAGINATION_PREFETCH_PAGES) {
  const safePage = Math.max(1, Math.trunc(Number(page) || 1));
  const safeSpan = Math.max(1, Math.trunc(Number(pageSpan) || 1));
  return Math.floor((safePage - 1) / safeSpan) * safeSpan + 1;
}

function clearPaginationPageCache() {
  paginationPageCache.clear();
  paginationBatchRequests.clear();
  paginationBatchEndCursor = null;
  paginationLastBatchEndPage = 0;
}

function cachePaginationPages(pages = {}) {
  if (!pages || typeof pages !== 'object') return;
  Object.entries(pages).forEach(([pageToken, list]) => {
    const pageNumber = Number.parseInt(pageToken, 10);
    if (!Number.isFinite(pageNumber) || pageNumber < 1) return;
    if (!Array.isArray(list)) return;
    // LRU: delete first so re-insertion moves it to the end of the Map
    paginationPageCache.delete(pageNumber);
    paginationPageCache.set(pageNumber, list);
  });
  // Evict oldest entries if over limit
  while (paginationPageCache.size > PAGINATION_CACHE_MAX_PAGES) {
    const oldestKey = paginationPageCache.keys().next().value;
    paginationPageCache.delete(oldestKey);
  }
}

function hasCachedPaginationBatch(batchStartPage, pageSpan = PAGINATION_PREFETCH_PAGES, totalPages = paginationTotalPages.value) {
  const safeStart = Math.max(1, Math.trunc(Number(batchStartPage) || 1));
  const safeSpan = Math.max(1, Math.trunc(Number(pageSpan) || 1));
  const safeTotal = Math.max(1, Math.trunc(Number(totalPages) || 1));
  const endPage = Math.min(safeTotal, safeStart + safeSpan - 1);
  for (let p = safeStart; p <= endPage; p += 1) {
    if (!paginationPageCache.has(p)) return false;
  }
  return true;
}

async function fetchGalleryNumberedPage(page = 1, pageSize = PAGINATION_VIEW_SIZE, sort = 'desc', pageSpan = 1, batchCursor = null) {
  const normalizedPage = Math.max(1, Math.trunc(Number(page) || 1));
  const normalizedPageSize = Math.max(1, Math.min(Math.trunc(Number(pageSize) || PAGINATION_VIEW_SIZE), 200));
  const normalizedSpan = Math.max(1, Math.min(Math.trunc(Number(pageSpan) || 1), 20));
  const params = new URLSearchParams();
  params.set('page', String(normalizedPage));
  params.set('pageSize', String(normalizedPageSize));
  params.set('pageSpan', String(normalizedSpan));
  if (sort === 'asc') params.set('sort', 'asc');
  if (batchCursor) params.set('batchCursor', batchCursor);

  const resp = await fetchWithRetry(`/api/gallery?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  let body = null;
  try {
    body = await resp.json();
  } catch (e) {
    body = null;
  }

  if (!resp.ok) {
    throw new Error(body?.error || 'Failed to load page');
  }

  const resolvedPage = Number.isFinite(Number(body?.page)) ? Math.max(1, Math.trunc(Number(body.page))) : normalizedPage;
  const resolvedItems = Array.isArray(body?.items) ? body.items : [];
  const pages = {};
  if (body?.pages && typeof body.pages === 'object') {
    Object.entries(body.pages).forEach(([pageToken, list]) => {
      const pageNumber = Number.parseInt(pageToken, 10);
      if (!Number.isFinite(pageNumber) || pageNumber < 1 || !Array.isArray(list)) return;
      pages[pageNumber] = list;
    });
  }
  if (!pages[resolvedPage]) {
    pages[resolvedPage] = resolvedItems;
  }

  return {
    items: resolvedItems,
    pages,
    page: resolvedPage,
    pageSize: Number.isFinite(Number(body?.pageSize)) ? Math.max(1, Math.trunc(Number(body.pageSize))) : normalizedPageSize,
    pageSpan: Number.isFinite(Number(body?.pageSpan)) ? Math.max(1, Math.trunc(Number(body.pageSpan))) : normalizedSpan,
    batchStartPage: Number.isFinite(Number(body?.batchStartPage))
      ? Math.max(1, Math.trunc(Number(body.batchStartPage)))
      : getPaginationBatchStart(resolvedPage, normalizedSpan),
    batchEndPage: Number.isFinite(Number(body?.batchEndPage))
      ? Math.max(1, Math.trunc(Number(body.batchEndPage)))
      : resolvedPage,
    batchEndCursor: body?.batchEndCursor || null,
    totalCount: Number.isFinite(Number(body?.totalCount)) ? Math.max(0, Math.trunc(Number(body.totalCount))) : 0,
    totalPages: Number.isFinite(Number(body?.totalPages)) ? Math.max(1, Math.trunc(Number(body.totalPages))) : 1,
    hasMore: Boolean(body?.hasMore),
  };
}

async function fetchGalleryNumberedBatch(page = 1, pageSize = PAGINATION_VIEW_SIZE, sort = 'desc', pageSpan = PAGINATION_PREFETCH_PAGES) {
  const normalizedPage = Math.max(1, Math.trunc(Number(page) || 1));
  const normalizedPageSize = Math.max(1, Math.min(Math.trunc(Number(pageSize) || PAGINATION_VIEW_SIZE), 200));
  const normalizedSpan = Math.max(1, Math.min(Math.trunc(Number(pageSpan) || PAGINATION_PREFETCH_PAGES), 20));
  const batchStartPage = getPaginationBatchStart(normalizedPage, normalizedSpan);
  const cacheKey = `${sort}:${normalizedPageSize}:${normalizedSpan}:${batchStartPage}`;
  const pendingRequest = paginationBatchRequests.get(cacheKey);
  if (pendingRequest) return pendingRequest;

  // Use cursor-based query when sequentially advancing to the next batch
  // (i.e. this batch starts right after the previous batch ended).
  // Otherwise fall back to skip-based pagination for random jumps.
  let cursorToUse = null;
  if (paginationBatchEndCursor && paginationLastBatchEndPage > 0 && batchStartPage === paginationLastBatchEndPage + 1) {
    cursorToUse = paginationBatchEndCursor;
  }

  const request = fetchGalleryNumberedPage(normalizedPage, normalizedPageSize, sort, normalizedSpan, cursorToUse)
    .then((result) => {
      // Store the endCursor and endPage from this batch for the next sequential fetch
      if (result.batchEndCursor) {
        paginationBatchEndCursor = result.batchEndCursor;
      }
      if (Number.isFinite(result.batchEndPage)) {
        paginationLastBatchEndPage = result.batchEndPage;
      }
      return result;
    })
    .finally(() => {
      paginationBatchRequests.delete(cacheKey);
    });
  paginationBatchRequests.set(cacheKey, request);
  return request;
}

async function prefetchPaginationAhead(currentPage = paginationPage.value) {
  if (displayMode.value !== 'pagination') return;
  const totalPages = Math.max(1, Math.trunc(Number(paginationTotalPages.value) || 1));
  const page = Math.max(1, Math.min(Math.trunc(Number(currentPage) || 1), totalPages));
  const batchStart = getPaginationBatchStart(page, PAGINATION_PREFETCH_PAGES);
  const prefetchThreshold = batchStart + Math.floor(PAGINATION_PREFETCH_PAGES / 2) - 1;
  if (page < prefetchThreshold) return;

  const nextBatchStart = batchStart + PAGINATION_PREFETCH_PAGES;
  if (nextBatchStart > totalPages) return;
  if (hasCachedPaginationBatch(nextBatchStart, PAGINATION_PREFETCH_PAGES, totalPages)) return;

  try {
    const batchData = await fetchGalleryNumberedBatch(
      nextBatchStart,
      PAGINATION_VIEW_SIZE,
      'desc',
      PAGINATION_PREFETCH_PAGES
    );
    cachePaginationPages(batchData.pages);
    cachePaginationPages({ [batchData.page]: batchData.items });
    if (Number.isFinite(Number(batchData.totalCount))) {
      paginationTotalCount.value = Math.max(0, Math.trunc(Number(batchData.totalCount)));
    }
    if (Number.isFinite(Number(batchData.totalPages))) {
      paginationTotalPages.value = Math.max(1, Math.trunc(Number(batchData.totalPages)));
    }

    const fetchedBatchItems = Object.values(batchData.pages || {})
      .filter((list) => Array.isArray(list))
      .flat();
    if (useIDB && fetchedBatchItems.length > 0) {
      putItems(fetchedBatchItems).catch((e) =>
        console.warn('Failed to cache prefetched pagination items in IDB:', e)
      );
    }
  } catch (e) {
    // Prefetch is best-effort and should not affect current page UX.
    console.warn('Pagination prefetch failed:', e);
  }
}

async function loadEntryImageNow(entry, fileId) {
  if (!entry || !fileId) return;
  if (pendingImageLoads.has(fileId)) return;
  pendingImageLoads.add(fileId);
  try {
    // 优先从 IndexedDB 读取缓存的图片 blob
    if (useIDB) {
      try {
        const cachedBlob = await getImageBlob(fileId);
        if (cachedBlob) {
          entry.displayFileId = fileId;
          entry.src = URL.createObjectURL(cachedBlob);
          entry.loading = false;
          return;
        }
      } catch (e) {
        // IDB 读取失败，继续从服务器加载
      }
    }

    // 从服务器获取图片并缓存 blob
    const fmt = getDisplayFormat(entry);
    const imageUrl = buildFileUrl(fileId, fmt, false);
    const resp = await fetchWithRetry(imageUrl, undefined, { retries: 1 });
    if (!resp.ok) throw new Error('Failed to fetch image');
    const blob = await resp.blob();

    entry.displayFileId = fileId;
    entry.src = URL.createObjectURL(blob);
    entry.loading = false;

    // 写入 IndexedDB 缓存（fire-and-forget）
    if (useIDB) {
      putImageBlob(fileId, blob).catch((e) =>
        console.warn('Failed to cache image blob in IDB:', e)
      );
    }

    setImageCache(fileId, imageUrl);
  } catch (err) {
    console.error('Failed to load image:', err);
    // 回退到直接 URL
    const imageUrl = buildFileUrl(fileId, getDisplayFormat(entry), false);
    entry.displayFileId = fileId;
    entry.src = imageUrl;
    entry.loading = false;
    setImageCache(fileId, imageUrl);
  } finally {
    pendingImageLoads.delete(fileId);
  }
}

function pumpImageLoadQueue() {
  while (activeImageLoadCount < MAX_CONCURRENT_IMAGE_LOADS && imageLoadQueue.length > 0) {
    const task = imageLoadQueue.shift();
    if (!task) break;

    const { entry, fileId } = task;
    queuedImageFileIds.delete(fileId);

    if (!entry || !fileId) continue;
    if (getDisplayFileId(entry) !== fileId) continue;
    if (entry.src && !entry.loading) continue;

    activeImageLoadCount += 1;
    void loadEntryImageNow(entry, fileId).finally(() => {
      activeImageLoadCount = Math.max(0, activeImageLoadCount - 1);
      pumpImageLoadQueue();
    });
  }
}

function loadEntryImage(entry) {
  const fileId = getDisplayFileId(entry);
  if (!fileId) return;
  if (entry.src && !entry.loading) return;
  if (pendingImageLoads.has(fileId) || queuedImageFileIds.has(fileId)) return;

  queuedImageFileIds.add(fileId);
  imageLoadQueue.push({ entry, fileId });
  pumpImageLoadQueue();
}

function queueImageLoads(targetEntries) {
  targetEntries.forEach((entry) => {
    if (!getDisplayFileId(entry)) return;
    if (entry.src && !entry.loading) return;
    loadEntryImage(entry);
  });
}

function mergeTopPage(serverItems, forceImageRefresh = false, keepExistingTail = false) {
  const visibleServerList = serverItems.filter((e) => !pendingDeleteIds.has(e.id));
  const imageCache = forceImageRefresh ? {} : getImageCache();
  const existingById = new Map(entries.value.map((entry) => [entry.id, entry]));
  const topEntries = visibleServerList.map((entry) =>
    buildEntryWithCache(entry, existingById.get(entry.id), imageCache, forceImageRefresh)
  );

  if (keepExistingTail) {
    const topIds = new Set(topEntries.map((entry) => entry.id));
    const tail = entries.value.filter((entry) => !topIds.has(entry.id));
    const combined = [...topEntries, ...tail];
    // 按当前排序方向排序，确保 IDB 缓存和服务器数据正确交错
    const dir = displayMode.value === 'asc' ? 1 : -1;
    combined.sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return ta !== tb ? (ta - tb) * dir : a.id.localeCompare(b.id) * dir;
    });
    entries.value = combined;
  } else {
    entries.value = topEntries;
  }

  setGalleryListCache(visibleServerList);
  queueImageLoads(getVisibleEntriesForCurrentMode());
  syncSelectionWithEntries();
}

function getSortForMode(mode = displayMode.value) {
  return mode === 'asc' ? 'asc' : 'desc';
}

function getVisibleEntriesForCurrentMode() {
  if (displayMode.value === 'pagination') {
    return entries.value;
  }
  return entries.value.slice(0, renderCount.value);
}

async function loadPaginationPage(targetPage = 1, options = {}) {
  error.value = "";
  const resolvedPage = Math.max(1, Math.trunc(Number(targetPage) || 1));
  const forceRefresh = Boolean(options?.forceRefresh);
  if (forceRefresh) {
    clearPaginationPageCache();
  }

  if (!forceRefresh) {
    const cachedItems = paginationPageCache.get(resolvedPage);
    if (Array.isArray(cachedItems)) {
      // LRU: move accessed page to the end
      paginationPageCache.delete(resolvedPage);
      paginationPageCache.set(resolvedPage, cachedItems);
      const visibleServerList = cachedItems.filter((entry) => !pendingDeleteIds.has(entry.id));
      const imageCache = getImageCache();
      const existingById = new Map(entries.value.map((entry) => [entry.id, entry]));
      entries.value = visibleServerList.map((entry) =>
        buildEntryWithCache(entry, existingById.get(entry.id), imageCache, false)
      );
      paginationPage.value = resolvedPage;
      paginationCursor.value = null;
      hasMore.value = false;
      renderCount.value = entries.value.length;
      queueImageLoads(getVisibleEntriesForCurrentMode());
      syncSelectionWithEntries();
      void prefetchPaginationAhead(resolvedPage);
      return;
    }
  }

  const isInitialLoad = entries.value.length === 0;

  if (isInitialLoad) {
    loading.value = true;
  } else {
    loadingMore.value = true;
  }

  try {
    const pageData = await fetchGalleryNumberedBatch(
      resolvedPage,
      PAGINATION_VIEW_SIZE,
      'desc',
      PAGINATION_PREFETCH_PAGES
    );
    cachePaginationPages(pageData.pages);
    cachePaginationPages({ [pageData.page]: pageData.items });

    const currentItems = paginationPageCache.get(pageData.page) || pageData.items;
    const visibleServerList = currentItems.filter((entry) => !pendingDeleteIds.has(entry.id));
    const imageCache = getImageCache();
    const existingById = new Map(entries.value.map((entry) => [entry.id, entry]));
    entries.value = visibleServerList.map((entry) =>
      buildEntryWithCache(entry, existingById.get(entry.id), imageCache, false)
    );

    paginationPage.value = pageData.page;
    paginationTotalCount.value = pageData.totalCount;
    paginationTotalPages.value = Math.max(1, pageData.totalPages);

    paginationCursor.value = null;
    hasMore.value = false;
    renderCount.value = entries.value.length;

    const fetchedBatchItems = Object.values(pageData.pages || {})
      .filter((list) => Array.isArray(list))
      .flat();
    if (useIDB && fetchedBatchItems.length > 0) {
      putItems(fetchedBatchItems).catch((e) =>
        console.warn('Failed to cache numbered-page items in IDB:', e)
      );
    }

    queueImageLoads(getVisibleEntriesForCurrentMode());
    syncSelectionWithEntries();
    void prefetchPaginationAhead(pageData.page);
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

async function load(forceImageRefresh = false, forceListRefresh = false) {
  if (displayMode.value === 'pagination') {
    await loadPaginationPage(paginationPage.value || 1, { forceRefresh: forceListRefresh });
    return;
  }

  error.value = "";
  const hadEntries = entries.value.length > 0;

  const currentSort = getSortForMode();

  if (!forceListRefresh && !hadEntries) {
    let cachedItems = null;

    // 优先从 IndexedDB 读取所有缓存（按当前排序方向）
    if (useIDB) {
      try {
        cachedItems = await getAllItems(undefined, currentSort);
      } catch (e) {
        // IDB 失败，回退到 localStorage
      }
    }

    // 回退到 localStorage（仅倒序模式）
    if ((!cachedItems || cachedItems.length === 0) && currentSort === 'desc') {
      const lsCache = getGalleryListCache();
      if (lsCache && lsCache.length > 0) {
        cachedItems = lsCache.slice(0, PAGE_SIZE);
      }
    }

    if (cachedItems && cachedItems.length > 0) {
      const visibleCachedList = cachedItems.filter((e) => !pendingDeleteIds.has(e.id));
      const imageCache = forceImageRefresh ? {} : getImageCache();
      entries.value = visibleCachedList.map((entry) =>
        buildEntryWithCache(entry, null, imageCache, forceImageRefresh)
      );
      renderCount.value = RENDER_BATCH;
      queueImageLoads(getVisibleEntriesForCurrentMode());
      loading.value = false;
    } else {
      loading.value = true;
    }
  } else if (!hadEntries) {
    loading.value = true;
  }

  try {
    const page = await fetchGalleryPage(null, PAGE_SIZE, currentSort);
    // 如果从缓存加载了数据，保留缓存的尾部（服务器只返回首页60条）
    mergeTopPage(page.items, forceImageRefresh, hadEntries);

    // 写入 IndexedDB 缓存
    if (useIDB && page.items.length > 0) {
      putItems(page.items).catch((e) =>
        console.warn('Failed to cache items in IDB:', e)
      );
    }

    // 始终用服务器的分页状态，确保能发现所有新入库的数据
    paginationCursor.value = page.nextCursor;
    hasMore.value = page.hasMore;
  } catch (e) {
    error.value = String(e);
    // 有缓存数据时不显示错误
    if (entries.value.length > 0) {
      error.value = "";
    }
  } finally {
    loading.value = false;
    if (!loadMoreObserver) {
      nextTick(() => {
        setupLoadMoreObserver();
      });
    }
  }
}

async function loadMore() {
  if (displayMode.value === 'pagination') return;
  if (loading.value || loadingMore.value) return;
  if (!hasMore.value || !paginationCursor.value) return;

  loadingMore.value = true;
  try {
    const currentSort = getSortForMode();
    const page = await fetchGalleryPage(paginationCursor.value, PAGE_SIZE, currentSort);
    const visibleItems = page.items.filter((entry) => !pendingDeleteIds.has(entry.id));
    const imageCache = getImageCache();
    const existingIds = new Set(entries.value.map((entry) => entry.id));
    const appendedEntries = [];

    visibleItems.forEach((entry) => {
      if (existingIds.has(entry.id)) return;
      appendedEntries.push(buildEntryWithCache(entry, null, imageCache, false));
      existingIds.add(entry.id);
    });

    if (appendedEntries.length > 0) {
      // 将新数据插入到正确的排序位置（而非简单追加到末尾）
      const combined = [...entries.value, ...appendedEntries];
      const dir = currentSort === 'asc' ? 1 : -1;
      combined.sort((a, b) => {
        const ta = new Date(a.timestamp).getTime();
        const tb = new Date(b.timestamp).getTime();
        return ta !== tb ? (ta - tb) * dir : a.id.localeCompare(b.id) * dir;
      });
      entries.value = combined;
      syncSelectionWithEntries();
      if (displayMode.value === 'pagination') {
        queueImageLoads(getVisibleEntriesForCurrentMode());
      }
    }

    paginationCursor.value = page.nextCursor;
    hasMore.value = page.hasMore;

    // 写入 IndexedDB 缓存
    if (useIDB && page.items.length > 0) {
      putItems(page.items).catch((e) =>
        console.warn('Failed to cache paginated items in IDB:', e)
      );
    }

    // 如果服务器返回的数据全部已存在（IDB 缓存重复），且还有更多数据，继续加载
    if (appendedEntries.length === 0 && page.hasMore && page.nextCursor) {
      loadingMore.value = false;
      void loadMore();
      return;
    }
  } catch (e) {
    error.value = String(e);
  } finally {
    loadingMore.value = false;
  }
}

function maybeLoadMoreForDetail(index = selectedIndex.value) {
  if (!Number.isFinite(index) || index < 0) return;
  const remaining = entries.value.length - 1 - index;
  if (remaining <= DETAIL_AUTO_LOAD_THRESHOLD) {
    void loadMore();
  }
}

function requestMoreForPhotoSwipe(index) {
  const targetIndex = Number.isFinite(index) ? index : selectedIndex.value;
  maybeLoadMoreForDetail(targetIndex);
}

function setupLoadMoreObserver() {
  if (typeof window === 'undefined' || !('IntersectionObserver' in window)) return;
  if (!loadMoreAnchor.value) return;

  if (loadMoreObserver) {
    loadMoreObserver.disconnect();
  }

  loadMoreObserver = new IntersectionObserver(
    (observedEntries) => {
      if (observedEntries.some((item) => item.isIntersecting)) {
        if (displayMode.value === 'pagination') return;
        void loadMore();
      }
    },
    {
      root: null,
      rootMargin: '600px 0px 600px 0px',
      threshold: 0.01,
    }
  );

  loadMoreObserver.observe(loadMoreAnchor.value);
}

function renderMore() {
  if (renderCount.value >= entries.value.length) return;
  const newCount = Math.min(renderCount.value + RENDER_BATCH, entries.value.length);
  renderCount.value = newCount;
  const newlyRendered = entries.value.slice(renderCount.value - RENDER_BATCH, renderCount.value);
  queueImageLoads(newlyRendered);
}

function setupRenderMoreObserver() {
  if (typeof window === 'undefined' || !('IntersectionObserver' in window)) return;
  if (!renderMoreAnchor.value) return;

  if (renderMoreObserver) {
    renderMoreObserver.disconnect();
  }

  renderMoreObserver = new IntersectionObserver(
    (observedEntries) => {
      if (observedEntries.some((item) => item.isIntersecting)) {
        if (displayMode.value === 'pagination') return;
        renderMore();
      }
    },
    {
      root: null,
      rootMargin: '800px 0px 800px 0px',
      threshold: 0.01,
    }
  );

  renderMoreObserver.observe(renderMoreAnchor.value);
}

// ========== 分类模式 ==========

const sortedCategories = computed(() => {
  return [...categoriesData.value].sort((a, b) => b.count - a.count);
});

async function loadCategories() {
  if (categoriesData.value.length > 0) return; // 已加载过
  categoriesLoading.value = true;
  try {
    const resp = await fetchWithRetry("/api/gallery/categories", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error("Failed to load categories");
    const data = await resp.json();
    categoriesData.value = data.categories || [];
  } catch (e) {
    error.value = String(e);
  } finally {
    categoriesLoading.value = false;
  }
}

async function toggleCategory(catId) {
  if (expandedCatId.value === catId) {
    expandedCatId.value = null;
    return;
  }
  expandedCatId.value = catId;
  const cat = categoriesData.value.find((c) => c.id === catId);
  if (!cat) return;
  for (const itemId of cat.items.slice(0, 20)) {
    if (categoryImages.value[itemId]) continue;
    loadCategoryImage(itemId);
  }
}

async function loadCategoryImage(itemId) {
  try {
    const items = await getAllItems();
    const entry = items.find((e) => e.id === itemId);
    if (entry) {
      const fileId = entry.telegram?.file_id_lossy || entry.telegram?.file_id;
      if (fileId) {
        const blob = await getImageBlob(fileId);
        if (blob) {
          categoryImages.value[itemId] = {
            src: URL.createObjectURL(blob),
            entry,
          };
          return;
        }
        const fmt = entry.telegram?.file_id_lossy_format || entry.telegram?.file_id_format || null;
        const filename = fmt ? `image.${fmt}` : 'image';
        categoryImages.value[itemId] = {
          src: `/api/file/${encodeURIComponent(fileId)}/${filename}`,
          entry,
        };
      }
    }
  } catch (e) { /* IDB unavailable */ }
}

function setDisplayMode(mode) {
  if (!DISPLAY_MODES.has(mode)) return;
  if (displayMode.value === mode) return;

  const prevMode = displayMode.value;
  const prevSort = getSortForMode(prevMode);
  const nextSort = getSortForMode(mode);

  displayMode.value = mode;
  localStorage.setItem('gallery_display_mode', mode);
  renderCount.value = RENDER_BATCH;

  if (mode === 'categories') {
    void loadCategories();
    return;
  }

  if (mode === 'pagination') {
    clearPaginationPageCache();
    paginationPage.value = 1;
    paginationJumpInput.value = "";
    paginationTotalCount.value = 0;
    paginationTotalPages.value = 1;
    entries.value = [];
    void loadPaginationPage(1);
    return;
  }

  // Leaving pagination mode always switches back to the list query flow.
  if (prevMode === 'pagination') {
    clearPaginationPageCache();
    entries.value = [];
    paginationCursor.value = null;
    hasMore.value = true;
    paginationPage.value = 1;
    paginationTotalCount.value = 0;
    paginationTotalPages.value = 1;
    paginationJumpInput.value = "";
    void load(false, true);
    return;
  }

  // Leaving categories mode always refreshes the list to match selected sort.
  if (prevMode === 'categories') {
    entries.value = [];
    paginationCursor.value = null;
    hasMore.value = true;
    void load(false, true);
    return;
  }

  if (prevSort !== nextSort) {
    entries.value = [];
    paginationCursor.value = null;
    hasMore.value = true;
    void load(false, true);
    return;
  }
}
async function refreshSingleImage(entry) {
  const displayFileId = getDisplayFileId(entry);
  if (!displayFileId) return;

  entry.loading = true;
  try {
    const imageUrl = buildFileUrl(displayFileId, getDisplayFormat(entry), true);
    const resp = await fetchWithRetry(imageUrl, undefined, { retries: 1 });
    if (!resp.ok) throw new Error('Failed to fetch image');
    const blob = await resp.blob();

    entry.displayFileId = displayFileId;
    entry.src = URL.createObjectURL(blob);
    entry.loading = false;

    if (useIDB) {
      putImageBlob(displayFileId, blob).catch((e) =>
        console.warn('Failed to cache refreshed image blob:', e)
      );
    }

    setImageCache(displayFileId, buildFileUrl(displayFileId, getDisplayFormat(entry), false));
  } catch (err) {
    console.error('Failed to refresh image:', err);
    entry.loading = false;
  }
}

function showClearCacheConfirm() {
  showClearCacheModal.value = true;
}

function cancelClearCache() {
  showClearCacheModal.value = false;
}

async function performClearCache() {
  showClearCacheModal.value = false;
  try {
    clearLocalStorageCaches();
    clearPaginationPageCache();

    // 清除 IndexedDB 所有数据（图片缓存 + 元数据缓存）
    if (useIDB) {
      await Promise.all([
        clearAll().catch((e) => console.warn('Failed to clear IDB items:', e)),
        clearImageBlobs().catch((e) => console.warn('Failed to clear IDB image blobs:', e)),
      ]);
    }

    entries.value = [];
    paginationCursor.value = null;
    hasMore.value = true;

    toastMessage.value = '所有缓存已清除，正在重新加载';
    showToast.value = true;
    setTimeout(() => { showToast.value = false; toastMessage.value = ''; }, 2500);

    await load(true, true);
  } catch (e) {
    console.error('Failed to clear cache:', e);
    toastMessage.value = '清除缓存失败: ' + String(e.message || e);
    showToast.value = true;
    setTimeout(() => { showToast.value = false; toastMessage.value = ''; }, 3500);
  }
}

function open(entry) {
  const index = entries.value.findIndex(e => e.id === entry.id);
  if (index < 0) return;
  if (selectedIndex.value < 0 && typeof window !== 'undefined') {
    window.history.pushState({ __galleryDetail: true }, '');
    hasDetailHistoryState = true;
  }
  selectedIndex.value = index;
  maybeLoadMoreForDetail(index);
}

function close() {
  if (selectedIndex.value < 0) return;
  selectedIndex.value = -1;
  if (hasDetailHistoryState && typeof window !== 'undefined') {
    suppressNextPopstate = true;
    hasDetailHistoryState = false;
    window.history.back();
  }
}

function prevImage() {
  if (selectedIndex.value > 0) {
    selectedIndex.value--;
  }
}

function nextImage() {
  if (selectedIndex.value < entries.value.length - 1) {
    selectedIndex.value++;
    maybeLoadMoreForDetail(selectedIndex.value);
  }
}

function setSelectedImageIndex(index) {
  if (!Number.isFinite(index)) return;
  const clamped = Math.max(0, Math.min(Number(index), entries.value.length - 1));
  if (clamped === selectedIndex.value) return;
  selectedIndex.value = clamped;
  maybeLoadMoreForDetail(clamped);
}

watch(selectedIndex, (index) => {
  maybeLoadMoreForDetail(index);
});

watch(
  () => entries.value.length,
  () => {
    if (displayMode.value !== 'pagination') return;
    const maxPage = loadedPaginationPages.value;
    if (paginationPage.value > maxPage) {
      paginationPage.value = maxPage;
    }
    queueImageLoads(getVisibleEntriesForCurrentMode());
  }
);

// 解析 prompt 为 tags
function parseTags(prompt) {
  if (!prompt) return [];
  if (parsedTagCache.has(prompt)) {
    return parsedTagCache.get(prompt);
  }

  const tags = prompt
    .replace(/[()]/g, '')
    .split(',')
    .map(t => t.trim())
    .filter(t => t);

  parsedTagCache.set(prompt, tags);
  if (parsedTagCache.size > TAG_PARSE_CACHE_MAX_ITEMS) {
    // Drop oldest cache entries to keep memory bounded.
    const dropCount = Math.max(1, Math.floor(TAG_PARSE_CACHE_MAX_ITEMS * 0.2));
    let dropped = 0;
    for (const cacheKey of parsedTagCache.keys()) {
      parsedTagCache.delete(cacheKey);
      dropped += 1;
      if (dropped >= dropCount) break;
    }
  }

  return tags;
}

// 为 tag 生成颜色（淡色背景+深色文字+描边）- 64种配色
const tagColors = [
  // 蓝色系 (8)
  { bg: '#e0f2fe', text: '#0c4a6e', border: '#7dd3fc' },
  { bg: '#dbeafe', text: '#1e3a8a', border: '#93c5fd' },
  { bg: '#e0e7ff', text: '#3730a3', border: '#a5b4fc' },
  { bg: '#e7e5e4', text: '#1c1917', border: '#a8a29e' },
  { bg: '#dfe9f3', text: '#1e40af', border: '#60a5fa' },
  { bg: '#e1e8f0', text: '#1e3a8a', border: '#7dd3fc' },
  { bg: '#dbeafe', text: '#1e293b', border: '#94a3b8' },
  { bg: '#e0f2fe', text: '#164e63', border: '#67e8f9' },

  // 紫色系 (8)
  { bg: '#ede9fe', text: '#5b21b6', border: '#c4b5fd' },
  { bg: '#f3e8ff', text: '#6b21a8', border: '#d8b4fe' },
  { bg: '#f5f3ff', text: '#4c1d95', border: '#c4b5fd' },
  { bg: '#fae8ff', text: '#86198f', border: '#f0abfc' },
  { bg: '#f3e8ff', text: '#581c87', border: '#e9d5ff' },
  { bg: '#ede9fe', text: '#6d28d9', border: '#a78bfa' },
  { bg: '#f5f3ff', text: '#7c3aed', border: '#c4b5fd' },
  { bg: '#fae8ff', text: '#a21caf', border: '#f0abfc' },

  // 粉红色系 (8)
  { bg: '#fce7f3', text: '#9f1239', border: '#f9a8d4' },
  { bg: '#fce7f3', text: '#831843', border: '#f9a8d4' },
  { bg: '#ffe4e6', text: '#9f1239', border: '#fda4af' },
  { bg: '#fef2f2', text: '#991b1b', border: '#fca5a5' },
  { bg: '#fce7f3', text: '#be185d', border: '#f9a8d4' },
  { bg: '#fff1f2', text: '#881337', border: '#fda4af' },
  { bg: '#fce7f3', text: '#9d174d', border: '#f472b6' },
  { bg: '#ffe4e6', text: '#be123c', border: '#fb7185' },

  // 橙红色系 (8)
  { bg: '#fed7aa', text: '#9a3412', border: '#fdba74' },
  { bg: '#fee2e2', text: '#991b1b', border: '#fca5a5' },
  { bg: '#ffedd5', text: '#9a3412', border: '#fdba74' },
  { bg: '#fef2f2', text: '#7f1d1d', border: '#fca5a5' },
  { bg: '#fff7ed', text: '#7c2d12', border: '#fed7aa' },
  { bg: '#fef3c7', text: '#92400e', border: '#fcd34d' },
  { bg: '#fed7aa', text: '#c2410c', border: '#fb923c' },
  { bg: '#fee2e2', text: '#b91c1c', border: '#f87171' },

  // 绿色系 (8)
  { bg: '#d1fae5', text: '#065f46', border: '#6ee7b7' },
  { bg: '#f0fdf4', text: '#14532d', border: '#86efac' },
  { bg: '#dcfce7', text: '#166534', border: '#86efac' },
  { bg: '#ecfdf5', text: '#065f46', border: '#6ee7b7' },
  { bg: '#d1fae5', text: '#047857', border: '#34d399' },
  { bg: '#f0fdf4', text: '#15803d', border: '#4ade80' },
  { bg: '#dcfce7', text: '#166534', border: '#22c55e' },
  { bg: '#ecfdf5', text: '#14532d', border: '#10b981' },

  // 青色系 (8)
  { bg: '#cffafe', text: '#164e63', border: '#67e8f9' },
  { bg: '#ecfeff', text: '#155e75', border: '#22d3ee' },
  { bg: '#e0f2fe', text: '#0c4a6e', border: '#38bdf8' },
  { bg: '#cffafe', text: '#0e7490', border: '#06b6d4' },
  { bg: '#ecfeff', text: '#164e63', border: '#67e8f9' },
  { bg: '#e0f2fe', text: '#075985', border: '#0ea5e9' },
  { bg: '#cffafe', text: '#155e75', border: '#22d3ee' },
  { bg: '#f0f9ff', text: '#0c4a6e', border: '#38bdf8' },

  // 黄绿色系 (8)
  { bg: '#fef9c3', text: '#713f12', border: '#fde047' },
  { bg: '#fefce8', text: '#713f12', border: '#fde047' },
  { bg: '#fef3c7', text: '#78350f', border: '#fcd34d' },
  { bg: '#fef9c3', text: '#854d0e', border: '#facc15' },
  { bg: '#ecfccb', text: '#3f6212', border: '#bef264' },
  { bg: '#fefce8', text: '#65a30d', border: '#a3e635' },
  { bg: '#f7fee7', text: '#1a2e05', border: '#84cc16' },
  { bg: '#ecfccb', text: '#365314', border: '#a3e635' },

  // 中性灰色系 (8)
  { bg: '#f5f5f4', text: '#1c1917', border: '#a8a29e' },
  { bg: '#fafaf9', text: '#292524', border: '#a8a29e' },
  { bg: '#f5f5f5', text: '#171717', border: '#a3a3a3' },
  { bg: '#fafafa', text: '#262626', border: '#a3a3a3' },
  { bg: '#f8fafc', text: '#0f172a', border: '#94a3b8' },
  { bg: '#f1f5f9', text: '#1e293b', border: '#94a3b8' },
  { bg: '#f9fafb', text: '#111827', border: '#9ca3af' },
  { bg: '#f3f4f6', text: '#1f2937', border: '#9ca3af' }
];
function getTagColor(tag) {
  const hash = tag.split('').reduce((acc, char) => char.charCodeAt(0) + acc, 0);
  return tagColors[hash % tagColors.length];
}

// 瀑布流左右优先：将图片分配到多列
const columnCount = ref(5);

const loadedPaginationPages = computed(() => Math.max(1, paginationTotalPages.value));
const renderedEntries = computed(() => (
  displayMode.value === 'pagination'
    ? entries.value
    : entries.value.slice(0, renderCount.value)
));
const hasMoreToRender = computed(() => (
  displayMode.value === 'pagination'
    ? false
    : renderCount.value < entries.value.length
));
const canGoPrevPaginationPage = computed(() => paginationPage.value > 1);
const canGoNextPaginationPage = computed(() => (
  paginationPage.value < loadedPaginationPages.value
));
const isPaginationBusy = computed(() => loading.value || loadingMore.value);
const visiblePaginationPages = computed(() => {
  const total = loadedPaginationPages.value;
  const current = Math.max(1, Math.min(paginationPage.value, total));
  const pages = [];

  if (total <= 11) {
    for (let i = 1; i <= total; i += 1) pages.push(i);
  } else {
    pages.push(1);

    const start = Math.max(2, current - 3);
    const end = Math.min(total - 1, current + 3);

    if (start > 2) pages.push("...");
    for (let i = start; i <= end; i += 1) pages.push(i);
    if (end < total - 1) pages.push("...");

    pages.push(total);
  }

  return pages;
});
const entryTagsById = computed(() => {
  const map = {};
  renderedEntries.value.forEach((entry) => {
    map[entry.id] = parseTags(entry.prompt);
  });
  return map;
});

const columns = computed(() => {
  const cols = Array.from({ length: columnCount.value }, () => []);
  const heights = new Array(columnCount.value).fill(0);

  renderedEntries.value.forEach((entry) => {
    const minIndex = heights.indexOf(Math.min(...heights));
    cols[minIndex].push(entry);
    heights[minIndex] += 1;
  });

  return cols;
});

async function goToPaginationPage(targetPage) {
  const parsedTarget = Number(targetPage);
  if (!Number.isFinite(parsedTarget)) return;
  const nextPage = Math.max(1, Math.min(Math.trunc(parsedTarget), loadedPaginationPages.value));
  if (nextPage === paginationPage.value) return;
  await loadPaginationPage(nextPage);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function submitPaginationJump() {
  const target = Number.parseInt(String(paginationJumpInput.value).trim(), 10);
  if (!Number.isFinite(target) || target < 1) return;
  paginationJumpInput.value = "";
  await goToPaginationPage(target);
}

// 响应式列数
function updateColumnCount() {
  const width = window.innerWidth;
  if (width < 576) columnCount.value = 1;
  else if (width < 768) columnCount.value = 2;
  else if (width < 992) columnCount.value = 3;
  else if (width < 1200) columnCount.value = 4;
  else columnCount.value = 5;
}

function getEntryTags(entry) {
  if (!entry || !entry.id) return [];
  return entryTagsById.value[entry.id] || [];
}

function ensureHistoryGuard() {
  if (typeof window === 'undefined') return;

  const currentState = (window.history.state && typeof window.history.state === 'object')
    ? window.history.state
    : {};

  if (!currentState.__galleryRoot) {
    window.history.replaceState({ ...currentState, __galleryRoot: true }, '');
  }
  window.history.pushState({ __galleryGuard: true }, '');
}

function handleRootBackPress() {
  const now = Date.now();
  if (now - lastRootBackAt <= ROOT_BACK_EXIT_WINDOW_MS) {
    window.removeEventListener('popstate', handlePopState);
    window.history.back();
    return;
  }

  lastRootBackAt = now;
  showToastMsg('再按一次返回退出网页', ROOT_BACK_EXIT_WINDOW_MS);
  window.history.pushState({ __galleryGuard: true }, '');
}

function handlePopState() {
  if (suppressNextPopstate) {
    suppressNextPopstate = false;
    return;
  }

  if (selectedIndex.value >= 0) {
    selectedIndex.value = -1;
    hasDetailHistoryState = false;
    return;
  }

  handleRootBackPress();
}

function handleKeydown(e) {
  if (displayMode.value !== 'pagination') return;
  if (selectedIndex.value >= 0) return;
  if (isPaginationBusy.value) return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  if (e.key === 'ArrowLeft' && canGoPrevPaginationPage.value) {
    e.preventDefault();
    void goToPaginationPage(paginationPage.value - 1);
  } else if (e.key === 'ArrowRight' && canGoNextPaginationPage.value) {
    e.preventDefault();
    void goToPaginationPage(paginationPage.value + 1);
  }
}

onMounted(() => {
  ensureHistoryGuard();
  void load();
  if (displayMode.value === 'categories') {
    void loadCategories();
  }
  updateColumnCount();
  window.addEventListener('resize', updateColumnCount);
  window.addEventListener('popstate', handlePopState);
  window.addEventListener('keydown', handleKeydown);
  nextTick(() => {
    setupLoadMoreObserver();
    setupRenderMoreObserver();
  });

  pollTimer = setInterval(() => {
    void load(false, true);
  }, 60000);
});

onUnmounted(() => {
  window.removeEventListener('resize', updateColumnCount);
  window.removeEventListener('popstate', handlePopState);
  window.removeEventListener('keydown', handleKeydown);
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (loadMoreObserver) {
    loadMoreObserver.disconnect();
    loadMoreObserver = null;
  }
  if (renderMoreObserver) {
    renderMoreObserver.disconnect();
    renderMoreObserver = null;
  }
  imageLoadQueue.length = 0;
  queuedImageFileIds.clear();
  pendingImageLoads.clear();
  activeImageLoadCount = 0;
  parsedTagCache.clear();
  clearPaginationPageCache();
});
</script>

<template>
  <div class="gallery-container">
    <!-- 工具栏 -->
    <header class="top-header">
      <div class="header-content">
        <div class="header-left">
          <!-- 显示模式切换 -->
          <div class="mode-switcher">
            <button
              :class="['mode-btn', { active: displayMode === 'desc' }]"
              @click="setDisplayMode('desc')"
              title="倒序（最新在前）"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <polyline points="19 12 12 19 5 12"/>
              </svg>
              <span class="mode-label">倒序</span>
            </button>
            <button
              :class="['mode-btn', { active: displayMode === 'asc' }]"
              @click="setDisplayMode('asc')"
              title="正序（最早在前）"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="19" x2="12" y2="5"/>
                <polyline points="5 12 12 5 19 12"/>
              </svg>
              <span class="mode-label">正序</span>
            </button>
            <button
              :class="['mode-btn', { active: displayMode === 'pagination' }]"
              @click="setDisplayMode('pagination')"
              title="分页显示"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="4" width="18" height="16" rx="2"/>
                <line x1="3" y1="10" x2="21" y2="10"/>
                <line x1="9" y1="20" x2="9" y2="10"/>
              </svg>
              <span class="mode-label">分页</span>
            </button>
            <button
              :class="['mode-btn', { active: displayMode === 'categories' }]"
              @click="setDisplayMode('categories')"
              title="按分类显示"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
              </svg>
              <span class="mode-label">分类</span>
            </button>
          </div>

          <div class="header-stats" v-if="entries.length > 0 && displayMode !== 'categories'">
            <span class="stats-count">{{ entries.length }}</span>
            <span class="stats-label">images</span>
          </div>
        </div>

        <div class="header-right">
          <!-- 批量模式控制 -->
          <template v-if="batchMode">
            <button @click="toggleSelectAllEntries" class="header-btn" :title="allEntriesSelected ? '取消全选' : '全选所有图片'">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 11l3 3L22 4"/>
                <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
              </svg>
              <span>{{ allEntriesSelected ? '取消' : '全选' }}</span>
            </button>
            <button @click="performBatchDelete" class="header-btn danger" :disabled="selectedCount === 0" :title="`删除选中的 ${selectedCount} 张图片`">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
              </svg>
              <span>删除 ({{ selectedCount }})</span>
            </button>
            <button @click="toggleBatchMode" class="header-btn" title="退出批量模式">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </template>

          <!-- 普通模式控制 -->
          <template v-else>
            <button @click="showClearCacheConfirm" class="header-btn" title="清除所有缓存">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                <line x1="10" y1="11" x2="10" y2="17"/>
                <line x1="14" y1="11" x2="14" y2="17"/>
              </svg>
            </button>
            <button @click="toggleBatchMode" class="header-btn" title="批量删除模式">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 11l3 3L22 4"/>
                <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
              </svg>
            </button>
            <span class="header-divider"></span>
            <button v-if="setView" @click="setView('database')" class="header-btn" title="数据库">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <ellipse cx="12" cy="5" rx="9" ry="3"/>
                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
              </svg>
            </button>
            <button v-if="toggleTheme" @click="toggleTheme()" class="header-btn" :title="theme === 'light' ? '切换深色模式' : '切换亮色模式'">
              <svg v-if="theme === 'light'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
              </svg>
              <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="5"/>
                <line x1="12" y1="1" x2="12" y2="3"/>
                <line x1="12" y1="21" x2="12" y2="23"/>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                <line x1="1" y1="12" x2="3" y2="12"/>
                <line x1="21" y1="12" x2="23" y2="12"/>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
              </svg>
            </button>
            <button @click="logout" class="header-btn" title="登出">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
            </button>
          </template>
        </div>
      </div>
    </header>

    <!-- 删除确认模态 -->
    <transition name="modal-fade">
      <div v-if="showDeleteModal" class="modal-overlay" @click.self="cancelDelete">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-icon danger">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="15" y1="9" x2="9" y2="15"/>
                <line x1="9" y1="9" x2="15" y2="15"/>
              </svg>
            </div>
            <h3 class="modal-title">确认删除</h3>
            <p class="modal-desc">确定要删除这张图片吗？此操作不可恢复。</p>
            <p v-if="pendingDelete?.prompt" class="modal-prompt">{{ pendingDelete.prompt }}</p>
            <div class="modal-buttons">
              <button class="modal-btn secondary" @click="cancelDelete">取消</button>
              <button class="modal-btn danger" @click="performDelete">删除</button>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <!-- 清除缓存确认模态框 -->
    <transition name="modal-fade">
      <div v-if="showClearCacheModal" class="modal-overlay" @click.self="cancelClearCache">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-icon warning">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            </div>
            <h3 class="modal-title">清除所有缓存</h3>
            <p class="modal-desc">将清除本地所有图片缓存和元数据缓存，清除后会从服务器重新加载数据。</p>
            <div class="modal-buttons">
              <button class="modal-btn secondary" @click="cancelClearCache">取消</button>
              <button class="modal-btn warning" @click="performClearCache">确认清除</button>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <!-- Toast 通知 -->
    <transition name="toast-slide">
      <div v-if="showToast" class="toast-notification">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        <span>{{ toastMessage }}</span>
      </div>
    </transition>

    <!-- 主内容区域 -->
    <main class="main-content">
      <!-- 加载状态 -->
      <div v-if="loading" class="loading-state">
        <div class="loading-spinner"></div>
        <p class="loading-text">加载中...</p>
      </div>

      <!-- 错误提示 -->
      <div v-if="error" class="error-message">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="15" y1="9" x2="9" y2="15"/>
          <line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
        <span>{{ error }}</span>
      </div>

      <!-- 批量模式提示 -->
      <div v-if="batchMode && displayMode !== 'categories'" class="batch-mode-banner">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 11l3 3L22 4"/>
          <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
        </svg>
        <span>已选择 <strong>{{ selectedCount }}</strong> 张图片，点击图片可选择/取消选择</span>
      </div>

      <!-- ====== 分类模式 ====== -->
      <template v-if="displayMode === 'categories'">
        <div v-if="categoriesLoading" class="loading-state">
          <div class="loading-spinner"></div>
          <p class="loading-text">正在分析图片分类...</p>
        </div>

        <div v-else-if="sortedCategories.length > 0" class="categories-content">
          <div class="categories-summary">
            <span class="stats-count">{{ sortedCategories.length }}</span>
            <span class="stats-label">个分类</span>
            <span class="stats-sep">/</span>
            <span class="stats-count">{{ entries.length }}</span>
            <span class="stats-label">张图片</span>
          </div>

          <div class="categories-list">
            <div
              v-for="cat in sortedCategories"
              :key="cat.id"
              :class="['cat-card', { expanded: expandedCatId === cat.id }]"
            >
              <div class="cat-header" @click="toggleCategory(cat.id)">
                <div class="cat-header-left">
                  <span class="cat-count">{{ cat.count }}</span>
                  <div class="cat-tags">
                    <span
                      v-for="(tag, idx) in cat.tags.slice(0, 6)"
                      :key="idx"
                      class="tag"
                      :style="{ backgroundColor: getTagColor(tag).bg, color: getTagColor(tag).text, borderColor: getTagColor(tag).border }"
                    >{{ tag }}</span>
                    <span v-if="cat.tags.length > 6" class="tag-more">+{{ cat.tags.length - 6 }}</span>
                  </div>
                </div>
                <svg
                  :class="['cat-chevron', { rotated: expandedCatId === cat.id }]"
                  width="20" height="20" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" stroke-width="2"
                >
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </div>

              <div v-if="expandedCatId === cat.id" class="cat-images">
                <div
                  v-for="itemId in cat.items.slice(0, 20)"
                  :key="itemId"
                  class="cat-thumb"
                >
                  <img
                    v-if="categoryImages[itemId]"
                    :src="categoryImages[itemId].src"
                    loading="lazy"
                    alt=""
                  />
                  <div v-else class="cat-thumb-placeholder">
                    <div class="placeholder-spinner"></div>
                  </div>
                </div>
                <div v-if="cat.items.length > 20" class="cat-more-images">
                  还有 {{ cat.items.length - 20 }} 张...
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-else-if="!categoriesLoading && !error" class="empty-state">
          <p class="empty-text">暂无分类数据</p>
        </div>
      </template>

      <!-- ====== 瀑布流模式（正序/倒序） ====== -->
      <template v-else>
        <!-- 分页模式（顶部） -->
        <div
          v-if="displayMode === 'pagination' && !loading && entries.length > 0"
          class="pagination-toolbar pagination-toolbar-top"
        >
          <div class="pagination-nav">
            <button
              class="pagination-btn pagination-icon-btn"
              :disabled="!canGoPrevPaginationPage || isPaginationBusy"
              @click="goToPaginationPage(1)"
              title="首页"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg>
            </button>
            <button
              class="pagination-btn pagination-icon-btn"
              :disabled="!canGoPrevPaginationPage || isPaginationBusy"
              @click="goToPaginationPage(paginationPage - 1)"
              title="上一页"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
          </div>

          <div class="pagination-pages" aria-label="分页页码">
            <button
              v-for="(pageToken, tokenIdx) in visiblePaginationPages"
              :key="`page-top-${tokenIdx}-${pageToken}`"
              :class="['pagination-btn', 'pagination-page-btn', { active: typeof pageToken === 'number' && pageToken === paginationPage }]"
              :disabled="pageToken === '...' || isPaginationBusy"
              @click="typeof pageToken === 'number' ? goToPaginationPage(pageToken) : null"
            >
              {{ pageToken }}
            </button>
          </div>

          <span class="pagination-info-compact">{{ paginationPage }}<span class="pagination-sep">/</span>{{ loadedPaginationPages }}</span>

          <div class="pagination-nav">
            <button
              class="pagination-btn pagination-icon-btn"
              :disabled="!canGoNextPaginationPage || isPaginationBusy"
              @click="goToPaginationPage(paginationPage + 1)"
              title="下一页"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
            <button
              class="pagination-btn pagination-icon-btn"
              :disabled="!canGoNextPaginationPage || isPaginationBusy"
              @click="goToPaginationPage(loadedPaginationPages)"
              title="尾页"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>
            </button>
          </div>

          <div class="pagination-jump">
            <input
              v-model="paginationJumpInput"
              class="pagination-jump-input"
              type="number"
              min="1"
              step="1"
              :placeholder="'跳至'"
              :disabled="isPaginationBusy"
              @keyup.enter="submitPaginationJump"
            />
            <button
              class="pagination-btn pagination-jump-btn"
              :disabled="isPaginationBusy"
              @click="submitPaginationJump"
            >
              GO
            </button>
          </div>
        </div>

        <!-- 瀑布流网格 -->
        <div class="gallery-grid" v-if="!loading">
          <div
            v-for="(column, colIndex) in columns"
            :key="colIndex"
            class="grid-column"
          >
            <div
              v-for="entry in column"
              :key="entry.id"
              :class="['image-card', { 'selected': batchMode && isEntrySelected(entry.id) }]"
              @click="batchMode ? toggleEntrySelection(entry.id) : open(entry)"
            >
              <!-- 图片区域 -->
              <div class="card-image-wrapper">
                <!-- 选择按钮 -->
                <button
                  v-if="batchMode"
                  :class="['select-checkbox', { 'checked': isEntrySelected(entry.id) }]"
                  @click.stop="toggleEntrySelection(entry.id)"
                  :title="isEntrySelected(entry.id) ? '取消选择' : '选择图片'"
                >
                  <svg v-if="isEntrySelected(entry.id)" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </button>

                <!-- 图片 -->
                <img
                  v-if="entry.src"
                  :src="entry.src"
                  :alt="entry.prompt"
                  class="card-image"
                  loading="lazy"
                />
                <div v-else class="card-placeholder">
                  <div class="placeholder-spinner"></div>
                </div>

                <!-- 操作按钮组 -->
                <div class="card-actions">
                  <button
                    class="action-btn delete"
                    @click.stop="openDeleteModal(entry)"
                    title="删除"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                    </svg>
                  </button>
                </div>
              </div>

              <!-- 标签区域 -->
              <div class="card-tags" v-if="entry.prompt && getEntryTags(entry).length > 0">
                <span
                  v-for="(tag, idx) in getEntryTags(entry).slice(0, 5)"
                  :key="idx"
                  class="tag"
                  :style="{
                    backgroundColor: getTagColor(tag).bg,
                    color: getTagColor(tag).text,
                    borderColor: getTagColor(tag).border
                  }"
                >
                  {{ tag }}
                </span>
                <span v-if="getEntryTags(entry).length > 5" class="tag-more">
                  +{{ getEntryTags(entry).length - 5 }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- 增量渲染锚点 -->
        <div
          ref="renderMoreAnchor"
          class="load-more-anchor"
          v-show="displayMode !== 'pagination' && !loading && hasMoreToRender"
          aria-hidden="true"
        ></div>

        <!-- 分页模式（底部） -->
        <div
          v-if="displayMode === 'pagination' && !loading && entries.length > 0"
          class="pagination-toolbar pagination-toolbar-bottom"
        >
          <div class="pagination-nav">
            <button
              class="pagination-btn pagination-icon-btn"
              :disabled="!canGoPrevPaginationPage || isPaginationBusy"
              @click="goToPaginationPage(1)"
              title="首页"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg>
            </button>
            <button
              class="pagination-btn pagination-icon-btn"
              :disabled="!canGoPrevPaginationPage || isPaginationBusy"
              @click="goToPaginationPage(paginationPage - 1)"
              title="上一页"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
          </div>

          <div class="pagination-pages" aria-label="分页页码">
            <button
              v-for="(pageToken, tokenIdx) in visiblePaginationPages"
              :key="`page-bottom-${tokenIdx}-${pageToken}`"
              :class="['pagination-btn', 'pagination-page-btn', { active: typeof pageToken === 'number' && pageToken === paginationPage }]"
              :disabled="pageToken === '...' || isPaginationBusy"
              @click="typeof pageToken === 'number' ? goToPaginationPage(pageToken) : null"
            >
              {{ pageToken }}
            </button>
          </div>

          <span class="pagination-info-compact">{{ paginationPage }}<span class="pagination-sep">/</span>{{ loadedPaginationPages }}</span>

          <div class="pagination-nav">
            <button
              class="pagination-btn pagination-icon-btn"
              :disabled="!canGoNextPaginationPage || isPaginationBusy"
              @click="goToPaginationPage(paginationPage + 1)"
              title="下一页"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
            <button
              class="pagination-btn pagination-icon-btn"
              :disabled="!canGoNextPaginationPage || isPaginationBusy"
              @click="goToPaginationPage(loadedPaginationPages)"
              title="尾页"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>
            </button>
          </div>

          <div class="pagination-jump">
            <input
              v-model="paginationJumpInput"
              class="pagination-jump-input"
              type="number"
              min="1"
              step="1"
              :placeholder="'跳至'"
              :disabled="isPaginationBusy"
              @keyup.enter="submitPaginationJump"
            />
            <button
              class="pagination-btn pagination-jump-btn"
              :disabled="isPaginationBusy"
              @click="submitPaginationJump"
            >
              GO
            </button>
          </div>
        </div>

        <div v-if="displayMode === 'pagination' && !loading && entries.length > 0" class="pagination-hint">
          本页 {{ entries.length }} 条，全部 {{ paginationTotalCount }} 条（共 {{ paginationTotalPages }} 页）
        </div>

        <!-- 瀑布流模式加载状态 -->
        <div v-if="displayMode !== 'pagination' && !loading && entries.length > 0" class="load-more-status">
          <div v-if="loadingMore" class="status-loading">
            <div class="mini-spinner"></div>
            <span>加载更多...</span>
          </div>
          <span v-else-if="hasMoreToRender" class="status-hint">{{ renderedEntries.length }} / {{ entries.length }}</span>
          <span v-else-if="hasMore" class="status-hint">下滑自动加载更多</span>
          <span v-else class="status-end">— 已加载全部 {{ entries.length }} 张 —</span>
        </div>

        <div
          ref="loadMoreAnchor"
          class="load-more-anchor"
          v-show="displayMode !== 'pagination' && !loading && hasMore && !hasMoreToRender && entries.length > 0"
          aria-hidden="true"
        ></div>

        <!-- 空状态 -->
        <div v-if="!loading && entries.length === 0" class="empty-state">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
          </svg>
          <p class="empty-text">暂无图片</p>
        </div>
      </template>
    </main>

    <!-- 详情弹窗 -->
    <ImageDetail
      v-if="selectedIndex >= 0"
      :entries="entries"
      :currentIndex="selectedIndex"
      :onClose="close"
      :onPrev="prevImage"
      :onNext="nextImage"
      :onSetIndex="setSelectedImageIndex"
      :onRefresh="() => refreshSingleImage(entries[selectedIndex])"
      :onNeedMore="requestMoreForPhotoSwipe"
    />
  </div>
</template>

<style scoped>
/* ========== 基础容器 ========== */
.gallery-container {
  min-height: 100vh;
  background: var(--bg-primary);
}

/* ========== 顶部导航栏 ========== */
.top-header {
  position: sticky;
  top: 0;
  z-index: 100;
  background: var(--bg-secondary);
  backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--border-color);
}

.header-content {
  max-width: 1600px;
  margin: 0 auto;
  padding: 0.5rem 1.25rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.header-title {
  font-size: 1.25rem;
  font-weight: 700;
  margin: 0;
  color: var(--text-primary);
  letter-spacing: -0.02em;
}

.header-stats {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  padding: 0.25rem 0.75rem;
  background: var(--bg-tertiary);
  border-radius: 0.5rem;
  font-size: 0.813rem;
}

.stats-count {
  font-weight: 700;
  color: var(--primary);
}

.stats-label {
  color: var(--text-muted);
  font-weight: 500;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.header-divider {
  width: 1px;
  height: 1.5rem;
  background: var(--border-color);
}

.header-btn {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 0.75rem;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 0.5rem;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  white-space: nowrap;
}

.header-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.header-btn:active {
  transform: scale(0.95);
}

.header-btn.danger {
  color: #ef4444;
}

.header-btn.danger:hover {
  background: rgba(239, 68, 68, 0.1);
  color: #dc2626;
}

.header-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  transform: none;
}

.header-btn svg {
  flex-shrink: 0;
}

.header-divider {
  width: 1px;
  height: 1.25rem;
  background: var(--border-color);
  flex-shrink: 0;
}

/* ========== 模态框 ========== */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
  padding: 1rem;
}

.modal-dialog {
  width: 100%;
  max-width: 400px;
}

.modal-content {
  background: var(--bg-secondary);
  border-radius: 1rem;
  padding: 1.5rem;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  border: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 1rem;
}

.modal-icon {
  width: 3rem;
  height: 3rem;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal-icon.danger {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.modal-icon.warning {
  background: rgba(245, 158, 11, 0.1);
  color: #f59e0b;
}

.modal-title {
  font-size: 1.125rem;
  font-weight: 700;
  margin: 0;
  color: var(--text-primary);
}

.modal-desc {
  font-size: 0.875rem;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.5;
}

.modal-prompt {
  font-size: 0.813rem;
  color: var(--text-muted);
  margin: 0;
  padding: 0.5rem 0.75rem;
  background: var(--bg-tertiary);
  border-radius: 0.5rem;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.modal-buttons {
  display: flex;
  gap: 0.625rem;
  width: 100%;
  margin-top: 0.5rem;
}

.modal-btn {
  flex: 1;
  padding: 0.75rem 1rem;
  border: none;
  border-radius: 0.625rem;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.modal-btn.secondary {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.modal-btn.secondary:hover {
  background: var(--bg-primary);
}

.modal-btn.danger {
  background: #ef4444;
  color: white;
}

.modal-btn.danger:hover {
  background: #dc2626;
}

.modal-btn.warning {
  background: #f59e0b;
  color: white;
}

.modal-btn.warning:hover {
  background: #d97706;
}

.modal-btn:active {
  transform: scale(0.95);
}

.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.modal-fade-enter-active .modal-content,
.modal-fade-leave-active .modal-content {
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}

.modal-fade-enter-from .modal-content {
  transform: scale(0.95);
}

.modal-fade-leave-to .modal-content {
  transform: scale(0.95);
}

/* ========== Toast 通知 ========== */
.toast-notification {
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
  z-index: 2100;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.toast-slide-enter-active {
  animation: slideDown 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.toast-slide-leave-active {
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
  max-width: 1600px;
  margin: 0 auto;
  padding: 1.5rem 1.25rem 3rem;
}

/* 加载状态 */
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 5rem 1rem;
  gap: 1rem;
}

.loading-spinner {
  width: 3rem;
  height: 3rem;
  border: 3px solid var(--border-color);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.loading-text {
  color: var(--text-secondary);
  font-size: 0.875rem;
  margin: 0;
}

/* 错误提示 */
.error-message {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 0.75rem;
  color: #ef4444;
  font-size: 0.875rem;
  margin-bottom: 1.5rem;
}

.error-message svg {
  flex-shrink: 0;
}

/* 批量模式横幅 */
.batch-mode-banner {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.875rem 1.25rem;
  background: rgba(99, 102, 241, 0.1);
  border: 1px solid rgba(99, 102, 241, 0.2);
  border-radius: 0.75rem;
  color: var(--primary);
  font-size: 0.875rem;
  margin-bottom: 1.5rem;
}

.batch-mode-banner svg {
  flex-shrink: 0;
}

.batch-mode-banner strong {
  font-weight: 700;
}

/* ========== 瀑布流网格 ========== */
.gallery-grid {
  display: flex;
  gap: 1rem;
}

.grid-column {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}

/* 图片卡片 */
.image-card {
  background: var(--bg-secondary);
  border-radius: 0.75rem;
  overflow: hidden;
  border: 1px solid var(--border-color);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.image-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  border-color: var(--primary);
}

.image-card.selected {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary), 0 8px 24px rgba(0, 0, 0, 0.12);
}

/* 图片区域 */
.card-image-wrapper {
  position: relative;
  background: var(--bg-tertiary);
  overflow: hidden;
}

.card-image {
  width: 100%;
  height: auto;
  display: block;
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.image-card:hover .card-image {
  transform: scale(1.02);
}

.card-placeholder {
  width: 100%;
  aspect-ratio: 3 / 4;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-tertiary);
}

.placeholder-spinner {
  width: 2rem;
  height: 2rem;
  border: 2px solid var(--border-color);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

/* 选择框 */
.select-checkbox {
  position: absolute;
  top: 0.625rem;
  left: 0.625rem;
  width: 1.75rem;
  height: 1.75rem;
  border: 2px solid rgba(255, 255, 255, 0.8);
  border-radius: 0.375rem;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(4px);
  color: white;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  z-index: 2;
}

.select-checkbox:hover {
  background: rgba(0, 0, 0, 0.6);
  border-color: white;
  transform: scale(1.1);
}

.select-checkbox.checked {
  background: var(--primary);
  border-color: var(--primary);
}

.select-checkbox.checked:hover {
  background: var(--primary-hover);
  border-color: var(--primary-hover);
}

/* 操作按钮组 */
.card-actions {
  position: absolute;
  top: 0.625rem;
  right: 0.625rem;
  display: flex;
  gap: 0.5rem;
  opacity: 0;
  transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  z-index: 2;
}

.image-card:hover .card-actions {
  opacity: 1;
}

.action-btn {
  width: 2rem;
  height: 2rem;
  border: none;
  border-radius: 0.375rem;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(4px);
  color: white;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.action-btn:hover {
  background: rgba(0, 0, 0, 0.6);
  transform: scale(1.1);
}

.action-btn.delete:hover {
  background: #ef4444;
}

.action-btn svg {
  flex-shrink: 0;
}

/* 标签区域 */
.card-tags {
  padding: 0.75rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  align-items: center;
}

.tag {
  display: inline-block;
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.2;
  border-radius: 0.375rem;
  border: 1.5px solid;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.tag:hover {
  transform: translateY(-1px);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.tag-more {
  display: inline-block;
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.2;
  border-radius: 0.375rem;
  background: var(--text-muted);
  color: var(--bg-primary);
}

/* 分页模式控制 */
.pagination-toolbar {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: 0.75rem;
  background: var(--bg-secondary);
}

.pagination-toolbar-top {
  margin-bottom: 1rem;
}

.pagination-toolbar-bottom {
  margin-top: 1.75rem;
}

.pagination-nav {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.pagination-pages {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex-wrap: wrap;
}

.pagination-jump {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.pagination-btn {
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  border-radius: 0.5rem;
  padding: 0.4rem 0.625rem;
  font-size: 0.813rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.pagination-btn:hover:not(:disabled) {
  background: var(--bg-tertiary);
  border-color: var(--primary);
}

.pagination-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.pagination-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.4rem;
  min-width: 2rem;
  min-height: 2rem;
}

.pagination-icon-btn svg {
  flex-shrink: 0;
}

.pagination-page-btn {
  min-width: 2.1rem;
  padding: 0.4rem 0.55rem;
  text-align: center;
}

.pagination-page-btn.active {
  border-color: var(--primary);
  background: color-mix(in srgb, var(--primary) 12%, var(--bg-secondary));
  color: var(--primary);
}

.pagination-info-compact {
  display: none;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
  padding: 0 0.25rem;
}

.pagination-info-compact .pagination-sep {
  margin: 0 0.2em;
  opacity: 0.5;
}

.pagination-jump-input {
  width: 4rem;
  border: 1px solid var(--border-color);
  border-radius: 0.5rem;
  padding: 0.4rem 0.5rem;
  font-size: 0.813rem;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  text-align: center;
}

.pagination-jump-input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 22%, transparent);
}

.pagination-jump-input::-webkit-outer-spin-button,
.pagination-jump-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.pagination-jump-input[type=number] {
  -moz-appearance: textfield;
}

.pagination-jump-btn {
  font-weight: 700;
  letter-spacing: 0.05em;
}

.pagination-hint {
  margin-top: 0.75rem;
  text-align: center;
  color: var(--text-muted);
  font-size: 0.813rem;
}

/* ========== 加载更多状态 ========== */
.load-more-status {
  margin-top: 2rem;
  text-align: center;
  color: var(--text-secondary);
  font-size: 0.875rem;
}

.status-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
}

.mini-spinner {
  width: 1.25rem;
  height: 1.25rem;
  border: 2px solid var(--border-color);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.status-hint {
  color: var(--text-muted);
}

.status-end {
  color: var(--text-muted);
  font-weight: 500;
}

.load-more-anchor {
  width: 100%;
  height: 1px;
}

/* ========== 空状态 ========== */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 5rem 1rem;
  gap: 1rem;
}

.empty-state svg {
  color: var(--text-muted);
  opacity: 0.5;
}

.empty-text {
  color: var(--text-secondary);
  font-size: 0.875rem;
  margin: 0;
}

/* ========== 响应式设计 ========== */
@media (max-width: 1024px) {
  .header-content {
    padding: 0.75rem 1rem;
  }
  
  .header-title {
    font-size: 1.125rem;
  }
  
  .main-content {
    padding: 1.25rem 1rem 2.5rem;
  }
}

@media (max-width: 768px) {
  .header-btn span {
    display: none;
  }
  
  .header-btn {
    padding: 0.5rem;
  }
  
  .header-stats {
    display: none;
  }
  
  .gallery-grid {
    gap: 0.75rem;
  }
  
  .grid-column {
    gap: 0.75rem;
  }

  .pagination-toolbar {
    gap: 0.375rem;
    padding: 0.5rem;
  }

  .pagination-pages {
    display: none;
  }

  .pagination-info-compact {
    display: inline;
  }

  .pagination-jump {
    order: 4;
  }
}

@media (max-width: 640px) {
  .header-right {
    gap: 0.375rem;
  }

  .main-content {
    padding: 1rem 0.75rem 2rem;
  }

  .batch-mode-banner {
    font-size: 0.813rem;
    padding: 0.75rem 1rem;
  }

  .pagination-toolbar {
    gap: 0.3rem;
    padding: 0.4rem;
  }

  .pagination-icon-btn {
    min-width: 1.75rem;
    min-height: 1.75rem;
    padding: 0.3rem;
  }

  .pagination-info-compact {
    font-size: 0.813rem;
  }

  .pagination-jump-input {
    width: 3.5rem;
    padding: 0.3rem 0.4rem;
    font-size: 0.75rem;
  }

  .pagination-jump-btn {
    padding: 0.3rem 0.5rem;
    font-size: 0.75rem;
  }
}

/* ========== 显示模式切换 ========== */
.mode-switcher {
  display: flex;
  background: var(--bg-tertiary);
  border-radius: 0.5rem;
  padding: 0.125rem;
  gap: 0.125rem;
}

.mode-btn {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.375rem 0.625rem;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 0.75rem;
  font-weight: 500;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.mode-btn:hover {
  color: var(--text-primary);
}

.mode-btn.active {
  background: var(--bg-secondary);
  color: var(--primary);
  box-shadow: 0 1px 2px rgba(0,0,0,0.08);
}

.mode-btn svg {
  flex-shrink: 0;
}

.stats-sep {
  color: var(--text-muted);
  margin: 0 0.25rem;
}

/* ========== 分类模式 ========== */
.categories-content {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.categories-summary {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  padding: 0.5rem 0.75rem;
  background: var(--bg-tertiary);
  border-radius: 0.5rem;
  font-size: 0.813rem;
}

.categories-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.cat-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 0.75rem;
  overflow: hidden;
  transition: box-shadow 0.2s;
}

.cat-card:hover {
  box-shadow: var(--shadow);
}

.cat-card.expanded {
  box-shadow: var(--shadow-lg);
}

.cat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.875rem 1rem;
  cursor: pointer;
  transition: background 0.2s;
}

.cat-header:hover {
  background: var(--bg-tertiary);
}

.cat-header-left {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
  flex: 1;
}

.cat-count {
  font-size: 1rem;
  font-weight: 700;
  color: var(--primary);
  background: var(--bg-tertiary);
  padding: 0.125rem 0.625rem;
  border-radius: 0.375rem;
  flex-shrink: 0;
}

.cat-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  min-width: 0;
}

.cat-chevron {
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform 0.2s;
}

.cat-chevron.rotated {
  transform: rotate(180deg);
}

.cat-images {
  padding: 0 1rem 1rem;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 0.5rem;
}

.cat-thumb {
  aspect-ratio: 1;
  border-radius: 0.5rem;
  overflow: hidden;
  background: var(--bg-tertiary);
}

.cat-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cat-thumb-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.cat-more-images {
  grid-column: 1 / -1;
  text-align: center;
  padding: 0.5rem;
  font-size: 0.813rem;
  color: var(--text-muted);
}

@media (max-width: 576px) {
  .mode-label {
    display: none;
  }
  .mode-btn {
    padding: 0.375rem 0.5rem;
  }
  .cat-images {
    grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
  }
}
</style>
