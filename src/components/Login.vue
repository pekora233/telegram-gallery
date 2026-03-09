<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';

const username = ref('');
const password = ref('');
const error = ref('');
const captchaProvider = ref('turnstile');
const turnstileToken = ref('');
const hcaptchaToken = ref('');
const turnstileWidgetId = ref(null);
const hcaptchaWidgetId = ref(null);
const emit = defineEmits(['login']);

// Turnstile 配置 - 需要在环境变量或配置中设置
const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || '1x00000000000000000000AA'; // 测试用的 site key
const HCAPTCHA_SITE_KEY = String(import.meta.env.VITE_HCAPTCHA_SITE_KEY || '').trim();
const hasHCaptchaSiteKey = HCAPTCHA_SITE_KEY.length > 0;

function renderTurnstile() {
  if (!window.turnstile || turnstileWidgetId.value !== null) return;
  if (!document.getElementById('turnstile-container')) return;

  turnstileWidgetId.value = window.turnstile.render('#turnstile-container', {
    sitekey: TURNSTILE_SITE_KEY,
    callback: (token) => {
      turnstileToken.value = token;
    },
    'expired-callback': () => {
      turnstileToken.value = '';
    },
    'error-callback': () => {
      error.value = '人机验证失败，请刷新页面重试';
      turnstileToken.value = '';
    },
    theme: 'light',
    size: 'normal',
  });
}

function renderHCaptcha() {
  if (!hasHCaptchaSiteKey) {
    error.value = '未配置 VITE_HCAPTCHA_SITE_KEY，hCaptcha 不可用';
    return;
  }
  if (!window.hcaptcha || hcaptchaWidgetId.value !== null) return;
  if (!document.getElementById('hcaptcha-container')) return;

  hcaptchaWidgetId.value = window.hcaptcha.render('hcaptcha-container', {
    sitekey: HCAPTCHA_SITE_KEY,
    callback: (token) => {
      hcaptchaToken.value = token;
    },
    'expired-callback': () => {
      hcaptchaToken.value = '';
    },
    'error-callback': () => {
      error.value = 'hCaptcha verification failed, please retry.';
      hcaptchaToken.value = '';
    },
    theme: 'light',
    size: 'normal',
  });
}

function resetTurnstile() {
  if (window.turnstile && turnstileWidgetId.value !== null) {
    window.turnstile.reset(turnstileWidgetId.value);
  }
  turnstileToken.value = '';
}

function resetHCaptcha() {
  if (window.hcaptcha && hcaptchaWidgetId.value !== null) {
    window.hcaptcha.reset(hcaptchaWidgetId.value);
  }
  hcaptchaToken.value = '';
}

function resetAllCaptchas() {
  resetTurnstile();
  resetHCaptcha();
}

function selectCaptchaProvider(provider) {
  if (provider === 'hcaptcha' && !hasHCaptchaSiteKey) {
    error.value = '未配置 VITE_HCAPTCHA_SITE_KEY，无法切换到 hCaptcha';
    return;
  }
  captchaProvider.value = provider;
  error.value = '';
  if (provider === 'turnstile') {
    renderTurnstile();
  } else {
    renderHCaptcha();
  }
}

onMounted(() => {
  if (!hasHCaptchaSiteKey && import.meta.env.DEV) {
    console.warn('[captcha] missing VITE_HCAPTCHA_SITE_KEY, hCaptcha is disabled');
  }

  if (window.turnstile) {
    if (captchaProvider.value === 'turnstile') renderTurnstile();
  } else {
    window.onloadTurnstileCallback = () => {
      if (captchaProvider.value === 'turnstile') renderTurnstile();
    };
  }

  if (window.hcaptcha) {
    if (captchaProvider.value === 'hcaptcha' && hasHCaptchaSiteKey) renderHCaptcha();
  } else if (hasHCaptchaSiteKey) {
    window.onloadHCaptchaCallback = () => {
      if (captchaProvider.value === 'hcaptcha') renderHCaptcha();
    };
  }
});

onBeforeUnmount(() => {
  if (window.turnstile && turnstileWidgetId.value !== null && typeof window.turnstile.remove === 'function') {
    window.turnstile.remove(turnstileWidgetId.value);
  }
  if (window.hcaptcha && hcaptchaWidgetId.value !== null && typeof window.hcaptcha.remove === 'function') {
    window.hcaptcha.remove(hcaptchaWidgetId.value);
  }
});

async function submit() {
  error.value = '';

  if (!turnstileToken.value && !hcaptchaToken.value) {
    error.value = '请完成 Turnstile 或 hCaptcha 人机验证';
    return;
  }

  try {
    const resp = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: username.value,
        password: password.value,
        turnstileToken: turnstileToken.value,
        hcaptchaToken: hcaptchaToken.value,
      }),
    });
    const j = await resp.json();
    if (!resp.ok) {
      error.value = j.error || '登录失败';
      resetAllCaptchas();
      return;
    }
    localStorage.setItem('gallery_token', j.token);
    emit('login');
  } catch (e) {
    error.value = String(e);
    resetAllCaptchas();
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-container">
      <!-- 装饰性背景 -->
      <div class="login-background">
        <div class="bg-circle bg-circle-1"></div>
        <div class="bg-circle bg-circle-2"></div>
        <div class="bg-circle bg-circle-3"></div>
      </div>

      <!-- 登录卡片 -->
      <div class="login-card">
        <!-- 卡片头部 -->
        <div class="card-header">
          <div class="header-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <circle cx="8.5" cy="8.5" r="1.5"/>
              <polyline points="21 15 16 10 5 21"/>
            </svg>
          </div>
          <h1 class="card-title">图床管理</h1>
          <p class="card-subtitle">登录以访问您的图片库</p>
        </div>

        <!-- 表单区域 -->
        <form class="login-form" @submit.prevent="submit">
          <div class="form-group">
            <label for="username" class="form-label">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
              </svg>
              <span>用户名</span>
            </label>
            <input
              id="username"
              v-model="username"
              type="text"
              class="form-input"
              placeholder="请输入用户名"
              autocomplete="username"
              required
            />
          </div>

          <div class="form-group">
            <label for="password" class="form-label">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
              <span>密码</span>
            </label>
            <input
              id="password"
              v-model="password"
              type="password"
              class="form-input"
              placeholder="请输入密码"
              autocomplete="current-password"
              required
            />
          </div>

          <div class="form-group">
            <div class="captcha-provider-switch">
              <button
                type="button"
                class="captcha-provider-btn"
                :class="{ active: captchaProvider === 'turnstile' }"
                @click="selectCaptchaProvider('turnstile')"
              >
                Turnstile
              </button>
              <button
                type="button"
                class="captcha-provider-btn"
                :class="{ active: captchaProvider === 'hcaptcha' }"
                :disabled="!hasHCaptchaSiteKey"
                :title="hasHCaptchaSiteKey ? 'hCaptcha' : '未配置 VITE_HCAPTCHA_SITE_KEY'"
                @click="selectCaptchaProvider('hcaptcha')"
              >
                hCaptcha
              </button>
            </div>
            <p v-if="!hasHCaptchaSiteKey" class="captcha-hint">未配置 VITE_HCAPTCHA_SITE_KEY，hCaptcha 已禁用</p>
          </div>

          <div class="form-group">
            <div v-show="captchaProvider === 'turnstile'" id="turnstile-container" class="captcha-wrapper"></div>
            <div v-show="captchaProvider === 'hcaptcha'" id="hcaptcha-container" class="captcha-wrapper"></div>
          </div>

          <!-- 错误提示 -->
          <div v-if="error" class="error-alert">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>{{ error }}</span>
          </div>

          <!-- 提交按钮 -->
          <button type="submit" class="submit-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
              <polyline points="10 17 15 12 10 7"/>
              <line x1="15" y1="12" x2="3" y2="12"/>
            </svg>
            <span>登录</span>
          </button>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ========== 登录页面容器 ========== */
.login-page {
  min-height: 100vh;
  background: linear-gradient(135deg, var(--bg-primary) 0%, var(--bg-secondary) 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  position: relative;
  overflow: hidden;
}

/* 装饰性背景 */
.login-background {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}

.bg-circle {
  position: absolute;
  border-radius: 50%;
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.1) 0%, rgba(139, 92, 246, 0.05) 100%);
  animation: float 20s ease-in-out infinite;
}

.bg-circle-1 {
  width: 400px;
  height: 400px;
  top: -200px;
  left: -200px;
  animation-delay: 0s;
}

.bg-circle-2 {
  width: 300px;
  height: 300px;
  bottom: -150px;
  right: -150px;
  animation-delay: -7s;
}

.bg-circle-3 {
  width: 250px;
  height: 250px;
  top: 50%;
  right: -125px;
  animation-delay: -14s;
}

@keyframes float {
  0%, 100% {
    transform: translate(0, 0) scale(1);
  }
  33% {
    transform: translate(30px, -30px) scale(1.1);
  }
  66% {
    transform: translate(-20px, 20px) scale(0.9);
  }
}

/* ========== 登录卡片 ========== */
.login-container {
  width: 100%;
  max-width: 420px;
  position: relative;
  z-index: 1;
}

.login-card {
  background: var(--bg-primary);
  border-radius: 1.25rem;
  border: 1px solid var(--border-color);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
  overflow: hidden;
  animation: slideUp 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 卡片头部 */
.card-header {
  text-align: center;
  padding: 2.5rem 2rem 2rem;
  background: linear-gradient(135deg, var(--bg-secondary) 0%, var(--bg-primary) 100%);
  border-bottom: 1px solid var(--border-color);
}

.header-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 4rem;
  height: 4rem;
  margin-bottom: 1.25rem;
  background: linear-gradient(135deg, var(--primary) 0%, var(--primary-hover) 100%);
  border-radius: 1rem;
  color: white;
  box-shadow: 0 8px 24px rgba(99, 102, 241, 0.25);
  animation: iconPulse 2s ease-in-out infinite;
}

@keyframes iconPulse {
  0%, 100% {
    transform: scale(1);
    box-shadow: 0 8px 24px rgba(99, 102, 241, 0.25);
  }
  50% {
    transform: scale(1.05);
    box-shadow: 0 12px 32px rgba(99, 102, 241, 0.35);
  }
}

.card-title {
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text-primary);
  margin: 0 0 0.5rem;
}

.card-subtitle {
  font-size: 0.875rem;
  color: var(--text-secondary);
  margin: 0;
}

/* ========== 表单区域 ========== */
.login-form {
  padding: 2rem;
}

.form-group {
  margin-bottom: 1.5rem;
}

.form-group:last-of-type {
  margin-bottom: 1rem;
}

.form-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.625rem;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: 0.01em;
}

.form-label svg {
  color: var(--primary);
  flex-shrink: 0;
}

.form-input {
  width: 100%;
  padding: 0.75rem 1rem;
  font-size: 0.9375rem;
  line-height: 1.5;
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1.5px solid var(--border-color);
  border-radius: 0.625rem;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.form-input::placeholder {
  color: var(--text-muted);
}

.form-input:hover {
  border-color: var(--primary);
}

.form-input:focus {
  outline: none;
  border-color: var(--primary);
  background: var(--bg-primary);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
}

/* Captcha switch and container */
.captcha-provider-switch {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
}

.captcha-provider-btn {
  height: 2.25rem;
  border: 1px solid var(--border-color);
  border-radius: 0.625rem;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.captcha-provider-btn:hover {
  border-color: var(--primary);
  color: var(--text-primary);
}

.captcha-provider-btn.active {
  border-color: var(--primary);
  background: rgba(99, 102, 241, 0.12);
  color: var(--text-primary);
}

.captcha-provider-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.captcha-hint {
  margin: 0.5rem 0 0;
  font-size: 0.75rem;
  color: #ef4444;
}

.captcha-wrapper {
  display: flex;
  justify-content: center;
  padding: 0.5rem 0;
}

/* ========== 错误提示 ========== */
.error-alert {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.875rem 1rem;
  margin-bottom: 1.25rem;
  background: rgba(239, 68, 68, 0.1);
  border: 1.5px solid rgba(239, 68, 68, 0.2);
  border-radius: 0.625rem;
  color: #ef4444;
  font-size: 0.875rem;
  font-weight: 500;
  animation: shake 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-8px); }
  75% { transform: translateX(8px); }
}

.error-alert svg {
  flex-shrink: 0;
}

/* ========== 提交按钮 ========== */
.submit-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.625rem;
  padding: 0.875rem 1.5rem;
  font-size: 0.9375rem;
  font-weight: 600;
  line-height: 1.5;
  color: white;
  background: linear-gradient(135deg, var(--primary) 0%, var(--primary-hover) 100%);
  border: none;
  border-radius: 0.625rem;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.25);
}

.submit-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 20px rgba(99, 102, 241, 0.35);
}

.submit-btn:active {
  transform: translateY(0);
  box-shadow: 0 2px 8px rgba(99, 102, 241, 0.25);
}

.submit-btn svg {
  flex-shrink: 0;
  transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.submit-btn:hover svg {
  transform: translateX(2px);
}

/* ========== 响应式设计 ========== */
@media (max-width: 480px) {
  .login-page {
    padding: 1rem;
  }

  .card-header {
    padding: 2rem 1.5rem 1.5rem;
  }

  .card-title {
    font-size: 1.5rem;
  }

  .header-icon {
    width: 3.5rem;
    height: 3.5rem;
    margin-bottom: 1rem;
  }

  .header-icon svg {
    width: 40px;
    height: 40px;
  }

  .login-form {
    padding: 1.5rem;
  }

  .form-group {
    margin-bottom: 1.25rem;
  }

  .bg-circle {
    opacity: 0.5;
  }
}

@media (max-width: 360px) {
  .login-card {
    border-radius: 1rem;
  }

  .card-header {
    padding: 1.5rem 1rem 1.25rem;
  }

  .login-form {
    padding: 1.25rem;
  }

  .form-input {
    padding: 0.625rem 0.875rem;
    font-size: 0.875rem;
  }

  .submit-btn {
    padding: 0.75rem 1.25rem;
    font-size: 0.875rem;
  }
}
</style>

