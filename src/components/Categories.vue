<script setup>
import { ref, onMounted, computed } from "vue";
import { getImageBlob, getAllItems } from "../utils/galleryDB.js";

const token = localStorage.getItem("gallery_token");
const loading = ref(false);
const error = ref("");
const categories = ref([]);
const totalItems = ref(0);
const totalCategories = ref(0);
const expandedId = ref(null);
const categoryImages = ref({});

const tagColors = [
  { bg: '#dbeafe', text: '#1e40af' }, { bg: '#e0e7ff', text: '#3730a3' },
  { bg: '#fce7f3', text: '#9d174d' }, { bg: '#fee2e2', text: '#991b1b' },
  { bg: '#dcfce7', text: '#166534' }, { bg: '#cffafe', text: '#155e75' },
  { bg: '#fef9c3', text: '#854d0e' }, { bg: '#f3e8ff', text: '#6b21a8' },
];

function getTagColor(tag) {
  const hash = tag.split('').reduce((acc, char) => char.charCodeAt(0) + acc, 0);
  return tagColors[hash % tagColors.length];
}

async function loadCategories() {
  loading.value = true;
  error.value = "";
  try {
    const resp = await fetch("/api/gallery/categories", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error("Failed to load categories");
    const data = await resp.json();
    categories.value = data.categories || [];
    totalItems.value = data.totalItems || 0;
    totalCategories.value = data.totalCategories || 0;
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function toggleCategory(catId) {
  if (expandedId.value === catId) {
    expandedId.value = null;
    return;
  }
  expandedId.value = catId;
  const cat = categories.value.find((c) => c.id === catId);
  if (!cat) return;

  // Load preview images for the expanded category
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
  } catch (e) {
    // IDB unavailable
  }
}

const sortedCategories = computed(() => {
  return [...categories.value].sort((a, b) => b.count - a.count);
});

onMounted(() => {
  loadCategories();
});
</script>

<template>
  <div class="categories-container">
    <!-- Loading -->
    <div v-if="loading" class="loading-state">
      <div class="spinner"></div>
      <p>正在分析图片分类...</p>
    </div>

    <!-- Error -->
    <div v-if="error" class="error-message">{{ error }}</div>

    <!-- Summary -->
    <div v-if="!loading && categories.length > 0" class="summary-bar">
      <div class="summary-item">
        <span class="summary-value">{{ totalCategories }}</span>
        <span class="summary-label">个分类</span>
      </div>
      <div class="summary-item">
        <span class="summary-value">{{ totalItems }}</span>
        <span class="summary-label">张图片</span>
      </div>
    </div>

    <!-- Category Cards -->
    <div v-if="!loading" class="categories-grid">
      <div
        v-for="cat in sortedCategories"
        :key="cat.id"
        :class="['category-card', { expanded: expandedId === cat.id }]"
      >
        <div class="card-header" @click="toggleCategory(cat.id)">
          <div class="card-header-left">
            <span class="card-count">{{ cat.count }}</span>
            <div class="card-tags">
              <span
                v-for="(tag, idx) in cat.tags.slice(0, 6)"
                :key="idx"
                class="tag"
                :style="{ backgroundColor: getTagColor(tag).bg, color: getTagColor(tag).text }"
              >{{ tag }}</span>
              <span v-if="cat.tags.length > 6" class="tag-more">+{{ cat.tags.length - 6 }}</span>
            </div>
          </div>
          <svg
            :class="['chevron', { rotated: expandedId === cat.id }]"
            width="20" height="20" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2"
          >
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>

        <!-- Expanded: image grid -->
        <div v-if="expandedId === cat.id" class="card-images">
          <div
            v-for="itemId in cat.items.slice(0, 20)"
            :key="itemId"
            class="image-thumb"
          >
            <img
              v-if="categoryImages[itemId]"
              :src="categoryImages[itemId].src"
              loading="lazy"
              alt=""
            />
            <div v-else class="thumb-placeholder">
              <div class="placeholder-spinner"></div>
            </div>
          </div>
          <div v-if="cat.items.length > 20" class="more-images">
            还有 {{ cat.items.length - 20 }} 张...
          </div>
        </div>
      </div>
    </div>

    <!-- Empty -->
    <div v-if="!loading && categories.length === 0 && !error" class="empty-state">
      <p>暂无分类数据</p>
    </div>
  </div>
</template>

<style scoped>
.categories-container {
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

.summary-bar {
  display: flex;
  gap: 2rem;
  margin-bottom: 1.5rem;
  padding: 1rem 1.25rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 0.75rem;
}

.summary-item {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
}

.summary-value {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--primary);
}

.summary-label {
  font-size: 0.875rem;
  color: var(--text-secondary);
}

.categories-grid {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.category-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 0.75rem;
  overflow: hidden;
  transition: box-shadow 0.2s;
}

.category-card:hover {
  box-shadow: var(--shadow);
}

.category-card.expanded {
  box-shadow: var(--shadow-lg);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  cursor: pointer;
  transition: background 0.2s;
}

.card-header:hover {
  background: var(--bg-tertiary);
}

.card-header-left {
  display: flex;
  align-items: center;
  gap: 1rem;
  min-width: 0;
  flex: 1;
}

.card-count {
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--primary);
  background: var(--bg-tertiary);
  padding: 0.25rem 0.75rem;
  border-radius: 0.5rem;
  flex-shrink: 0;
}

.card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  min-width: 0;
}

.tag {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  border-radius: 0.25rem;
  font-size: 0.75rem;
  font-weight: 500;
  white-space: nowrap;
}

.tag-more {
  font-size: 0.75rem;
  color: var(--text-muted);
  padding: 0.125rem 0.375rem;
}

.chevron {
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform 0.2s;
}

.chevron.rotated {
  transform: rotate(180deg);
}

.card-images {
  padding: 0 1.25rem 1.25rem;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 0.5rem;
}

.image-thumb {
  aspect-ratio: 1;
  border-radius: 0.5rem;
  overflow: hidden;
  background: var(--bg-tertiary);
}

.image-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumb-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.placeholder-spinner {
  width: 1.25rem;
  height: 1.25rem;
  border: 2px solid var(--border-color);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.more-images {
  grid-column: 1 / -1;
  text-align: center;
  padding: 0.5rem;
  font-size: 0.813rem;
  color: var(--text-muted);
}

.empty-state {
  text-align: center;
  padding: 4rem 2rem;
  color: var(--text-secondary);
}

@media (max-width: 576px) {
  .categories-container {
    padding: 1rem;
  }
  .card-images {
    grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
  }
}
</style>
