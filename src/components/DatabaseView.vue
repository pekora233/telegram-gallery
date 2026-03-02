<script setup>
import { ref, onMounted, onUnmounted, computed, inject, watch, nextTick } from "vue";
import * as echarts from "echarts/core";
import { PieChart } from "echarts/charts";
import { TooltipComponent, LegendComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { getItemCount, getImageBlob } from "../utils/galleryDB.js";

echarts.use([PieChart, TooltipComponent, LegendComponent, CanvasRenderer]);

const emit = defineEmits(["back"]);
const theme = inject('theme', ref('light'));
const toggleTheme = inject('toggleTheme', null);

const token = localStorage.getItem("gallery_token");
const loading = ref(false);
const error = ref("");
const stats = ref(null);
const items = ref([]);
const imageSizes = ref({});

// Search & pagination
const searchQuery = ref("");
const sortBy = ref("timestamp");
const sortDesc = ref(true);
const currentPage = ref(1);
const pageSize = 50;
const jumpPage = ref("");

// IDB stats
const idbUsage = ref(null);
const idbImageCount = ref(0);

// Image preview
const previewSrc = ref(null);

const filteredItems = computed(() => {
  let result = [...items.value];
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase();
    result = result.filter(
      (item) =>
        (item.prompt || "").toLowerCase().includes(q) ||
        (item.id || "").toLowerCase().includes(q) ||
        (item.metadata?.model || "").toLowerCase().includes(q)
    );
  }
  result.sort((a, b) => {
    let va, vb;
    if (sortBy.value === "timestamp") {
      va = a.timestamp || "";
      vb = b.timestamp || "";
    } else {
      va = a.id;
      vb = b.id;
    }
    if (va < vb) return sortDesc.value ? 1 : -1;
    if (va > vb) return sortDesc.value ? -1 : 1;
    return 0;
  });
  return result;
});

const totalPages = computed(() => Math.max(1, Math.ceil(filteredItems.value.length / pageSize)));
const pagedItems = computed(() => {
  const start = (currentPage.value - 1) * pageSize;
  return filteredItems.value.slice(start, start + pageSize);
});

// Numbered pagination: show pages around current
const visiblePages = computed(() => {
  const total = totalPages.value;
  const cur = currentPage.value;
  const pages = [];
  if (total <= 7) {
    for (let i = 1; i <= total; i++) pages.push(i);
  } else {
    pages.push(1);
    if (cur > 3) pages.push('...');
    const start = Math.max(2, cur - 1);
    const end = Math.min(total - 1, cur + 1);
    for (let i = start; i <= end; i++) pages.push(i);
    if (cur < total - 2) pages.push('...');
    pages.push(total);
  }
  return pages;
});

function goToPage(p) {
  if (typeof p === 'number' && p >= 1 && p <= totalPages.value) {
    currentPage.value = p;
  }
}

function handleJump() {
  const p = parseInt(jumpPage.value);
  if (p >= 1 && p <= totalPages.value) {
    currentPage.value = p;
    jumpPage.value = "";
  }
}

function toggleSort(field) {
  if (sortBy.value === field) {
    sortDesc.value = !sortDesc.value;
  } else {
    sortBy.value = field;
    sortDesc.value = true;
  }
  currentPage.value = 1;
}

function formatBytes(bytes) {
  if (bytes === 0 || bytes == null) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + " " + sizes[i];
}

function formatDate(ts) {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("zh-CN");
}

function truncate(str, len = 60) {
  if (!str) return "-";
  return str.length > len ? str.slice(0, len) + "..." : str;
}

function getThumbUrl(item) {
  const fileId = item.telegram?.file_id_lossy || item.telegram?.file_id;
  if (!fileId) return '';
  const fmt = item.telegram?.file_id_lossy_format || item.telegram?.file_id_format || null;
  const filename = fmt ? `image.${fmt}` : 'image';
  return `/api/file/${encodeURIComponent(fileId)}/${filename}`;
}

function openPreview(item) {
  const fileId = item.telegram?.file_id_lossy || item.telegram?.file_id;
  if (!fileId) return;
  const fmt = item.telegram?.file_id_lossy_format || item.telegram?.file_id_format || null;
  const filename = fmt ? `image.${fmt}` : 'image';
  previewSrc.value = `/api/file/${encodeURIComponent(fileId)}/${filename}`;
}

// Model normalization: strip special chars + lowercase → group as same model
function normalizeModelName(name) {
  return name.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '').toLowerCase();
}

const modelEntries = computed(() => {
  if (!stats.value?.models) return [];
  // Group by normalized key, pick one display name per group
  const grouped = {};
  for (const [name, count] of Object.entries(stats.value.models)) {
    if (!name || name === 'unknown') continue;
    const key = normalizeModelName(name);
    if (!key) continue;
    if (!grouped[key]) {
      grouped[key] = { displayName: name, count: 0 };
    }
    grouped[key].count += count;
    // Prefer the longer/more descriptive name for display
    if (name.length > grouped[key].displayName.length) {
      grouped[key].displayName = name;
    }
  }
  return Object.values(grouped)
    .sort((a, b) => b.count - a.count);
});

const totalModelItems = computed(() => {
  return modelEntries.value.reduce((sum, e) => sum + e.count, 0);
});

// ECharts
const pieChartRef = ref(null);
let chartInstance = null;

function initChart() {
  if (!pieChartRef.value || modelEntries.value.length === 0) return;
  if (chartInstance) chartInstance.dispose();
  chartInstance = echarts.init(pieChartRef.value);
  updateChart();
}

function updateChart() {
  if (!chartInstance) return;
  const isDark = theme.value === 'dark';
  const data = modelEntries.value.map((entry, idx) => ({
    name: entry.displayName,
    value: entry.count,
    itemStyle: { color: barColors[idx % barColors.length] },
  }));
  chartInstance.setOption({
    tooltip: {
      trigger: 'item',
      backgroundColor: isDark ? '#1f2937' : '#fff',
      borderColor: isDark ? '#374151' : '#e5e7eb',
      textStyle: { color: isDark ? '#f3f4f6' : '#111827', fontSize: 13 },
      formatter: (p) => `<b>${p.name}</b><br/>${p.value} 张 (${p.percent}%)`,
    },
    series: [{
      type: 'pie',
      radius: ['45%', '75%'],
      center: ['50%', '50%'],
      avoidLabelOverlap: true,
      itemStyle: { borderRadius: 4, borderColor: isDark ? '#1f2937' : '#fff', borderWidth: 2 },
      label: { show: false },
      emphasis: {
        label: { show: true, fontSize: 14, fontWeight: 600 },
        itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.2)' },
      },
      data,
    }],
  });
}

function resizeChart() {
  chartInstance?.resize();
}

// Color palette for model bars
const barColors = [
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#f97316', '#eab308',
  '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
];

function getBarColor(index) {
  return barColors[index % barColors.length];
}

async function loadStats() {
  loading.value = true;
  error.value = "";
  try {
    const resp = await fetch("/api/gallery/stats", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error("Failed to load stats");
    const data = await resp.json();
    stats.value = data;
    items.value = data.items || [];
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function loadIDBStats() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      idbUsage.value = est;
    }
  } catch (e) { /* ignore */ }

  try {
    idbImageCount.value = await getItemCount();
  } catch (e) { /* ignore */ }
}

async function loadImageSizes() {
  for (const item of items.value) {
    const fileId = item.telegram?.file_id_lossy || item.telegram?.file_id;
    if (!fileId) continue;
    try {
      const blob = await getImageBlob(fileId);
      if (blob) {
        imageSizes.value[item.id] = blob.size;
      }
    } catch (e) { /* ignore */ }
  }
}

const totalImageSize = computed(() => {
  return Object.values(imageSizes.value).reduce((sum, size) => sum + size, 0);
});

watch(() => searchQuery.value, () => { currentPage.value = 1; });

// Re-init chart when data or theme changes
watch([modelEntries, theme], () => {
  nextTick(() => {
    if (chartInstance) updateChart();
    else initChart();
  });
});

onMounted(async () => {
  window.addEventListener('resize', resizeChart);
  await loadStats();
  nextTick(initChart);
  loadIDBStats();
  loadImageSizes();
});

onUnmounted(() => {
  window.removeEventListener('resize', resizeChart);
  if (chartInstance) {
    chartInstance.dispose();
    chartInstance = null;
  }
});
</script>

<template>
  <div class="db-page">
    <header class="db-header">
      <div class="db-header-content">
        <button class="db-back-btn" @click="emit('back')" title="返回画廊">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="19" y1="12" x2="5" y2="12"/>
            <polyline points="12 19 5 12 12 5"/>
          </svg>
          <span>数据库</span>
        </button>
        <div class="db-header-right">
          <button v-if="toggleTheme" @click="toggleTheme()" class="db-icon-btn" :title="theme === 'light' ? '切换深色模式' : '切换亮色模式'">
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
        </div>
      </div>
    </header>
    <div class="db-container">
      <!-- Loading -->
      <div v-if="loading" class="loading-state">
        <div class="spinner"></div>
        <p>加载数据库统计...</p>
      </div>

      <!-- Error -->
      <div v-if="error" class="error-message">{{ error }}</div>

      <template v-if="!loading && stats">
        <!-- Stats Cards -->
        <div class="stats-grid">
          <div class="stat-card stat-card--purple">
            <div class="stat-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
            </div>
            <div class="stat-info">
              <span class="stat-value">{{ stats.totalItems }}</span>
              <span class="stat-label">总记录数</span>
            </div>
          </div>

          <div class="stat-card stat-card--blue">
            <div class="stat-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <ellipse cx="12" cy="5" rx="9" ry="3"/>
                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
              </svg>
            </div>
            <div class="stat-info">
              <span class="stat-value">{{ idbImageCount }}</span>
              <span class="stat-label">IndexedDB 缓存条数</span>
            </div>
          </div>

          <div class="stat-card stat-card--teal">
            <div class="stat-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
              </svg>
            </div>
            <div class="stat-info">
              <span class="stat-value">{{ idbUsage ? formatBytes(idbUsage.usage) : '-' }}</span>
              <span class="stat-label">存储占用</span>
            </div>
          </div>

          <div class="stat-card stat-card--orange">
            <div class="stat-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/>
                <polyline points="13 2 13 9 20 9"/>
              </svg>
            </div>
            <div class="stat-info">
              <span class="stat-value">{{ formatBytes(totalImageSize) }}</span>
              <span class="stat-label">图片缓存总大小</span>
            </div>
          </div>

          <div class="stat-card stat-card--green">
            <div class="stat-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12 6 12 12 16 14"/>
              </svg>
            </div>
            <div class="stat-info">
              <span class="stat-value stat-value-sm">{{ formatDate(stats.newestTimestamp) }}</span>
              <span class="stat-label">最新记录</span>
            </div>
          </div>

          <div class="stat-card stat-card--rose">
            <div class="stat-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12 6 12 12 8 14"/>
              </svg>
            </div>
            <div class="stat-info">
              <span class="stat-value stat-value-sm">{{ formatDate(stats.oldestTimestamp) }}</span>
              <span class="stat-label">最早记录</span>
            </div>
          </div>
        </div>

        <!-- Model Distribution -->
        <div class="section" v-if="modelEntries.length > 0">
          <div class="section-header">
            <h2 class="section-title">模型分布</h2>
            <span class="section-badge">{{ modelEntries.length }} 个模型 · {{ totalModelItems }} 张图片</span>
          </div>
          <div class="model-chart-container">
            <div ref="pieChartRef" class="pie-chart"></div>
            <div class="model-legend">
              <div v-for="(entry, idx) in modelEntries" :key="idx" class="legend-item">
                <span class="legend-dot" :style="{ background: getBarColor(idx) }"></span>
                <span class="legend-name" :title="entry.displayName">{{ entry.displayName }}</span>
                <span class="legend-count">{{ entry.count }}</span>
                <span class="legend-pct">{{ (entry.count / totalModelItems * 100).toFixed(1) }}%</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Detailed List -->
        <div class="section">
          <div class="list-header">
            <h2 class="section-title">详细记录</h2>
            <div class="search-box">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8"/>
                <line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <input
                v-model="searchQuery"
                type="text"
                placeholder="搜索 prompt、ID、model..."
              />
            </div>
          </div>

          <div class="table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th class="col-thumb">缩略图</th>
                  <th class="col-id">ID</th>
                  <th class="col-prompt">Prompt</th>
                  <th class="col-model">Model</th>
                  <th class="col-size">尺寸</th>
                  <th class="col-cache">缓存大小</th>
                  <th class="col-time sortable" @click="toggleSort('timestamp')">
                    时间
                    <span v-if="sortBy === 'timestamp'" class="sort-arrow">{{ sortDesc ? '↓' : '↑' }}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in pagedItems" :key="item.id">
                  <td class="col-thumb">
                    <div class="table-thumb" @click="openPreview(item)">
                      <img
                        v-if="item.telegram?.file_id_lossy || item.telegram?.file_id"
                        :src="getThumbUrl(item)"
                        loading="lazy"
                        alt=""
                      />
                    </div>
                  </td>
                  <td class="col-id" :title="item.id">{{ item.id.slice(-8) }}</td>
                  <td class="col-prompt" :title="item.prompt">{{ truncate(item.prompt) }}</td>
                  <td class="col-model">{{ item.metadata?.model || '-' }}</td>
                  <td class="col-size">{{ item.metadata?.width || '?' }} × {{ item.metadata?.height || '?' }}</td>
                  <td class="col-cache">{{ imageSizes[item.id] ? formatBytes(imageSizes[item.id]) : '-' }}</td>
                  <td class="col-time">{{ formatDate(item.timestamp) }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- Pagination -->
          <div class="pagination" v-if="totalPages > 1">
            <button class="page-btn" :disabled="currentPage <= 1" @click="goToPage(1)" title="首页">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/>
              </svg>
            </button>
            <button class="page-btn" :disabled="currentPage <= 1" @click="goToPage(currentPage - 1)" title="上一页">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
            </button>

            <template v-for="p in visiblePages" :key="p">
              <span v-if="p === '...'" class="page-ellipsis">...</span>
              <button v-else :class="['page-num', { active: p === currentPage }]" @click="goToPage(p)">{{ p }}</button>
            </template>

            <button class="page-btn" :disabled="currentPage >= totalPages" @click="goToPage(currentPage + 1)" title="下一页">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </button>
            <button class="page-btn" :disabled="currentPage >= totalPages" @click="goToPage(totalPages)" title="末页">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/>
              </svg>
            </button>

            <div class="page-jump">
              <span>跳至</span>
              <input
                v-model="jumpPage"
                type="number"
                :min="1"
                :max="totalPages"
                @keyup.enter="handleJump"
              />
              <span>页</span>
            </div>
            <span class="page-total">共 {{ filteredItems.length }} 条</span>
          </div>
        </div>
      </template>
    </div>

    <!-- Image Preview Overlay -->
    <transition name="preview-fade">
      <div v-if="previewSrc" class="preview-overlay" @click="previewSrc = null">
        <div class="preview-wrapper" @click.stop>
          <img :src="previewSrc" class="preview-img" />
          <button class="preview-close" @click="previewSrc = null">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.db-page {
  min-height: 100vh;
}

.db-header {
  position: sticky;
  top: 0;
  z-index: 100;
  background: var(--bg-secondary);
  backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--border-color);
}

.db-header-content {
  max-width: 1600px;
  margin: 0 auto;
  padding: 0.5rem 1.25rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.db-back-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.5rem;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 1rem;
  font-weight: 700;
  cursor: pointer;
  border-radius: 0.5rem;
  transition: all 0.2s;
}

.db-back-btn:hover {
  background: var(--bg-tertiary);
}

.db-back-btn:active {
  transform: scale(0.97);
}

.db-header-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.db-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 0.5rem;
  cursor: pointer;
  transition: all 0.2s;
}

.db-icon-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.db-container {
  max-width: 1600px;
  margin: 0 auto;
  padding: 1.5rem 1.25rem;
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4rem 2rem;
  color: var(--text-secondary);
  gap: 1rem;
}

.spinner {
  width: 2rem;
  height: 2rem;
  border: 2px solid var(--border-color);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.error-message {
  text-align: center;
  padding: 2rem;
  color: #ef4444;
}

/* ========== Stats Cards ========== */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1.25rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 0.75rem;
  transition: box-shadow 0.2s, transform 0.2s;
  border-left: 3px solid transparent;
}

.stat-card:hover {
  box-shadow: var(--shadow);
  transform: translateY(-1px);
}

.stat-card--purple { border-left-color: #8b5cf6; }
.stat-card--purple .stat-icon { background: rgba(139, 92, 246, 0.1); color: #8b5cf6; }
.stat-card--blue { border-left-color: #3b82f6; }
.stat-card--blue .stat-icon { background: rgba(59, 130, 246, 0.1); color: #3b82f6; }
.stat-card--teal { border-left-color: #14b8a6; }
.stat-card--teal .stat-icon { background: rgba(20, 184, 166, 0.1); color: #14b8a6; }
.stat-card--orange { border-left-color: #f97316; }
.stat-card--orange .stat-icon { background: rgba(249, 115, 22, 0.1); color: #f97316; }
.stat-card--green { border-left-color: #22c55e; }
.stat-card--green .stat-icon { background: rgba(34, 197, 94, 0.1); color: #22c55e; }
.stat-card--rose { border-left-color: #f43f5e; }
.stat-card--rose .stat-icon { background: rgba(244, 63, 94, 0.1); color: #f43f5e; }

.stat-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 3rem;
  height: 3rem;
  border-radius: 0.75rem;
  flex-shrink: 0;
}

.stat-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.stat-value {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.2;
}

.stat-value-sm {
  font-size: 0.938rem;
}

.stat-label {
  font-size: 0.813rem;
  color: var(--text-secondary);
  margin-top: 0.125rem;
}

/* ========== Sections ========== */
.section {
  margin-bottom: 2rem;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.section-title {
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.section-badge {
  font-size: 0.75rem;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  padding: 0.2rem 0.6rem;
  border-radius: 1rem;
}

/* ========== Model Distribution ========== */
.model-chart-container {
  display: flex;
  gap: 2rem;
  align-items: center;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 0.75rem;
  padding: 1.5rem;
}

.pie-chart {
  width: 240px;
  height: 240px;
  flex-shrink: 0;
}

.model-legend {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  max-height: 320px;
  overflow-y: auto;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.375rem 0.5rem;
  border-radius: 0.375rem;
  transition: background 0.15s;
}

.legend-item:hover {
  background: var(--bg-tertiary);
}

.legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.legend-name {
  flex: 1;
  min-width: 0;
  font-size: 0.813rem;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: text;
  user-select: all;
}

.legend-count {
  font-size: 0.813rem;
  font-weight: 600;
  color: var(--text-primary);
  flex-shrink: 0;
}

.legend-pct {
  width: 3.5rem;
  text-align: right;
  font-size: 0.75rem;
  color: var(--text-muted);
  flex-shrink: 0;
}

/* ========== List Header ========== */
.list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
  gap: 1rem;
  flex-wrap: wrap;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 0.5rem;
  min-width: 250px;
  transition: border-color 0.2s;
}

.search-box:focus-within {
  border-color: var(--primary);
}

.search-box svg {
  color: var(--text-muted);
  flex-shrink: 0;
}

.search-box input {
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 0.875rem;
  width: 100%;
}

.search-box input::placeholder {
  color: var(--text-muted);
}

/* ========== Table ========== */
.table-wrapper {
  overflow-x: auto;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 0.75rem;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.813rem;
}

.data-table thead {
  background: var(--bg-tertiary);
}

.data-table th {
  padding: 0.75rem 0.875rem;
  text-align: left;
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
  border-bottom: 1px solid var(--border-color);
}

.data-table th.sortable {
  cursor: pointer;
  user-select: none;
}

.data-table th.sortable:hover {
  color: var(--primary);
}

.sort-arrow {
  margin-left: 0.25rem;
}

.data-table td {
  padding: 0.625rem 0.875rem;
  border-bottom: 1px solid var(--border-color);
  color: var(--text-primary);
  vertical-align: middle;
}

.data-table tbody tr:hover {
  background: var(--bg-tertiary);
}

.data-table tbody tr:last-child td {
  border-bottom: none;
}

.col-thumb {
  width: 48px;
}

.table-thumb {
  width: 40px;
  height: 40px;
  border-radius: 0.375rem;
  overflow: hidden;
  background: var(--bg-tertiary);
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
}

.table-thumb:hover {
  transform: scale(1.1);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.table-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.col-id {
  font-family: monospace;
  font-size: 0.75rem;
  color: var(--text-muted);
}

.col-prompt {
  max-width: 300px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.col-model {
  white-space: nowrap;
}

.col-size {
  white-space: nowrap;
  font-family: monospace;
  font-size: 0.75rem;
}

.col-cache {
  white-space: nowrap;
  font-family: monospace;
  font-size: 0.75rem;
}

.col-time {
  white-space: nowrap;
  font-size: 0.75rem;
}

/* ========== Pagination ========== */
.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  padding: 1.25rem 0;
  flex-wrap: wrap;
}

.page-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  border-radius: 0.375rem;
  cursor: pointer;
  font-size: 0.875rem;
  transition: all 0.15s;
}

.page-btn:hover:not(:disabled) {
  background: var(--bg-tertiary);
  border-color: var(--primary);
  color: var(--primary);
}

.page-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.page-num {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 2rem;
  height: 2rem;
  padding: 0 0.5rem;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-primary);
  border-radius: 0.375rem;
  cursor: pointer;
  font-size: 0.875rem;
  font-weight: 500;
  transition: all 0.15s;
}

.page-num:hover {
  background: var(--bg-tertiary);
}

.page-num.active {
  background: var(--primary);
  color: white;
  font-weight: 600;
  border-color: var(--primary);
}

.page-ellipsis {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  color: var(--text-muted);
  font-size: 0.875rem;
  user-select: none;
}

.page-jump {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin-left: 0.75rem;
  font-size: 0.813rem;
  color: var(--text-secondary);
}

.page-jump input {
  width: 3.5rem;
  height: 2rem;
  text-align: center;
  border: 1px solid var(--border-color);
  border-radius: 0.375rem;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 0.813rem;
  outline: none;
  transition: border-color 0.2s;
}

.page-jump input:focus {
  border-color: var(--primary);
}

/* Hide number input arrows */
.page-jump input::-webkit-outer-spin-button,
.page-jump input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.page-jump input[type=number] {
  -moz-appearance: textfield;
}

.page-total {
  font-size: 0.813rem;
  color: var(--text-muted);
  margin-left: 0.75rem;
}

/* ========== Image Preview ========== */
.preview-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.preview-wrapper {
  position: relative;
  max-width: 90vw;
  max-height: 90vh;
  cursor: default;
}

.preview-img {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 0.5rem;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.preview-close {
  position: absolute;
  top: -2.5rem;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.375rem;
  border: none;
  background: rgba(255, 255, 255, 0.15);
  color: white;
  border-radius: 0.5rem;
  cursor: pointer;
  transition: background 0.2s;
}

.preview-close:hover {
  background: rgba(255, 255, 255, 0.25);
}

.preview-fade-enter-active {
  transition: opacity 0.2s;
}
.preview-fade-leave-active {
  transition: opacity 0.15s;
}
.preview-fade-enter-from,
.preview-fade-leave-to {
  opacity: 0;
}

/* ========== Responsive ========== */
@media (max-width: 768px) {
  .db-container {
    padding: 1rem;
  }
  .stats-grid {
    grid-template-columns: 1fr 1fr;
  }
  .model-chart-container {
    flex-direction: column;
    align-items: stretch;
  }
  .pie-chart {
    width: 100%;
    height: 200px;
  }
  .legend-name {
    white-space: normal;
    word-break: break-all;
    line-height: 1.3;
  }
  .legend-pct {
    display: none;
  }
  .search-box {
    min-width: 0;
    flex: 1;
  }
  .col-prompt {
    max-width: 150px;
  }
  .page-jump {
    display: none;
  }
}

@media (max-width: 576px) {
  .stats-grid {
    grid-template-columns: 1fr;
  }
}
</style>
