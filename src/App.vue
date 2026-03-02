<script setup>
import { ref, onMounted, watch, provide, defineAsyncComponent } from "vue";
import Login from "./components/Login.vue";
import Gallery from "./components/Gallery.vue";
const DatabaseView = defineAsyncComponent(() => import("./components/DatabaseView.vue"));

const token = ref(localStorage.getItem("gallery_token"));
const theme = ref(localStorage.getItem("gallery_theme") || "light");
const currentView = ref("gallery");

function onLogin() {
  token.value = localStorage.getItem("gallery_token");
}

function toggleTheme() {
  theme.value = theme.value === "light" ? "dark" : "light";
}

function setView(view) {
  currentView.value = view;
}

provide("theme", theme);
provide("toggleTheme", toggleTheme);
provide("currentView", currentView);
provide("setView", setView);

onMounted(() => {
  document.documentElement.setAttribute("data-theme", theme.value);
});

watch(theme, (newTheme) => {
  document.documentElement.setAttribute("data-theme", newTheme);
  localStorage.setItem("gallery_theme", newTheme);
});
</script>

<template>
  <div id="app">
    <template v-if="token">
      <Gallery v-show="currentView === 'gallery'" />
      <DatabaseView v-if="currentView === 'database'" @back="setView('gallery')" />
    </template>
    <transition name="fade" mode="out-in">
      <Login v-if="!token" key="login" @login="onLogin" />
    </transition>
  </div>
</template>

<style scoped>
#app {
  min-height: 100vh;
  position: relative;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
