import { test, expect } from "@playwright/test";

function makeEntries(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `entry-${index + 1}`,
    prompt: `page ${index + 1}`,
    timestamp: new Date(Date.UTC(2026, 2, 1, 0, 0, count - index)).toISOString(),
    telegram: {
      file_id: `original-${index + 1}`,
      file_id_format: "png",
      ...(index === 0 ? { file_id_lossy: "lossy /1", file_id_lossy_format: "webp" } : {})
    },
    metadata: { width: 600, height: 900 }
  }));
}

async function setupGallery(page, { more = false, missingImage = false, noImages = false, theme = "light" } = {}) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.location().url.endsWith("/vite.svg")) errors.push(message.text());
  });
  await page.route("https://challenges.cloudflare.com/**", (route) => route.fulfill({ body: "" }));
  await page.route("https://js.hcaptcha.com/**", (route) => route.fulfill({ body: "" }));
  await page.addInitScript(({ selectedTheme, manualLoadMore }) => {
    localStorage.setItem("gallery_token", "test-token");
    localStorage.setItem("gallery_theme", selectedTheme);
    if (manualLoadMore) {
      const NativeObserver = window.IntersectionObserver;
      window.IntersectionObserver = class extends NativeObserver {
        observe(target) {
          if (!target.classList.contains("load-more-anchor")) super.observe(target);
        }
      };
    }
  }, { selectedTheme: theme, manualLoadMore: more });
  const entries = makeEntries(more ? 18 : 12);
  if (missingImage) entries[1].telegram = {};
  if (noImages) entries.forEach((entry) => { entry.telegram = {}; });
  let moreRequests = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/gallery") {
      const cursor = url.searchParams.get("cursor");
      if (cursor) moreRequests += 1;
      const items = more ? cursor ? entries.slice(12) : entries.slice(0, 12) : entries;
      await route.fulfill({
        json: { items, hasMore: more && !cursor, nextCursor: more && !cursor ? "next-page" : null }
      });
      return;
    }
    if (url.pathname.startsWith("/api/file/")) {
      const fileId = decodeURIComponent(url.pathname.split("/")[3]);
      const pageNumber = fileId.match(/\d+/)?.[0] || "1";
      await route.fulfill({
        contentType: "image/svg+xml",
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="#e7eef8"/><rect x="30" y="30" width="540" height="600" fill="#94b2d8"/><text x="300" y="760" text-anchor="middle" font-size="72">Page ${pageNumber}</text></svg>`
      });
      return;
    }
    await route.fulfill({ json: [] });
  });
  await page.goto("/");
  await expect(page.locator(".image-card")).toHaveCount(12);
  return { errors, getMoreRequests: () => moreRequests };
}

async function openReader(page, pageNumber = 1) {
  const card = page.locator(".image-card").filter({ has: page.locator(`img[alt="page ${pageNumber}"]`) });
  await card.click();
  await page.getByRole("button", { name: "漫画阅读", exact: true }).click();
  const reader = page.getByRole("dialog", { name: "漫画阅读" });
  await expect(reader).toBeVisible();
  await expect(reader.getByRole("slider", { name: "阅读进度" })).toBeVisible();
  return reader;
}

const pageCount = (reader) => reader.locator(".mv-footer-info span").first();

async function captureReader(page, reader, path) {
  await expect(reader.locator(".mv-loading-screen")).toHaveCSS("opacity", "0");
  await expect.poll(() => reader.locator(".mv-page-slot img").evaluateAll((images) => {
    const visible = images.filter((image) => {
      const bounds = image.getBoundingClientRect();
      return bounds.left < innerWidth && bounds.right > 0 && bounds.top < innerHeight && bounds.bottom > 0;
    });
    return visible.length > 0 && visible.every((image) => image.complete && image.naturalWidth > 0);
  })).toBe(true);
  await page.screenshot({ path });
}

test("desktop uses spreads, preserves PhotoSwipe and fits the viewport", async ({ page }, testInfo) => {
  const { errors } = await setupGallery(page, { theme: "dark" });
  const reader = await openReader(page);
  await expect(pageCount(reader)).toHaveText("1 / 12");
  await reader.locator(".reader-host").press("ArrowLeft");
  await expect(pageCount(reader)).toHaveText("2-3 / 12");
  await expect(reader.locator(".mv-container")).toHaveCSS("background-color", "rgb(0, 0, 0)");
  const bounds = await reader.locator(".mv-container").boundingBox();
  expect(bounds.y).toBeGreaterThan(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(801);
  await captureReader(page, reader, testInfo.outputPath("desktop-reader.png"));
  await reader.getByRole("button", { name: "返回图片详情" }).click();
  await expect(page.locator(".counter-current")).toHaveText("2");
  await page.getByTitle("全屏查看", { exact: true }).click();
  await expect(page.locator(".pswp")).toBeVisible();
  await expect(page.locator(".pswp")).toBeFocused();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator(".pswp")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test.describe("portrait reader", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("starts at selection, switches direction and mode without losing position", async ({ page }, testInfo) => {
    const { errors } = await setupGallery(page);
    const reader = await openReader(page, 3);
    await expect(pageCount(reader)).toHaveText("3 / 12");
    await reader.locator(".reader-host").press("ArrowLeft");
    await expect(pageCount(reader)).toHaveText("4 / 12");
    await reader.getByLabel("阅读方向").selectOption("ltr");
    await expect(pageCount(reader)).toHaveText("4 / 12");
    await reader.locator(".reader-host").press("ArrowRight");
    await expect(pageCount(reader)).toHaveText("5 / 12");
    await reader.getByLabel("阅读模式").selectOption("scroll");
    await expect(reader.locator(".mv-scroll-mode")).toBeVisible();
    await expect(pageCount(reader)).toHaveText("5 / 12");
    await reader.getByLabel("阅读模式").selectOption("page");
    await expect(pageCount(reader)).toHaveText("5 / 12");
    const toolbar = await reader.locator(".reader-toolbar").boundingBox();
    expect(toolbar.width).toBeLessThanOrEqual(390);
    await captureReader(page, reader, testInfo.outputPath("mobile-reader.png"));
    await reader.locator(".reader-host").press("Escape");
    await expect(reader).toHaveCount(0);
    await expect(page.locator(".counter-current")).toHaveText("5");
    await page.getByRole("button", { name: "漫画阅读", exact: true }).click();
    await expect(page.getByLabel("阅读方向")).toHaveValue("ltr");
    await expect(pageCount(reader)).toHaveText("5 / 12");
    await reader.getByRole("button", { name: "返回图片详情" }).click();
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("gallery_manga_session_")))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("near the end loads more pages and retains the current image", async ({ page }) => {
    const { errors, getMoreRequests } = await setupGallery(page, { more: true });
    const reader = await openReader(page);
    await reader.locator(".reader-host").press("End");
    await expect(pageCount(reader)).toHaveText("12 / 18");
    await reader.locator(".reader-host").press("ArrowLeft");
    await expect(pageCount(reader)).toHaveText("13 / 18");
    expect(getMoreRequests()).toBe(1);
    expect(errors).toEqual([]);
  });

  test("filters unavailable images, maps indexes and encodes lossy file URLs", async ({ page }) => {
    const { errors } = await setupGallery(page, { missingImage: true });
    const reader = await openReader(page);
    await expect(pageCount(reader)).toHaveText("1 / 11");
    await expect(reader.locator('img[src="/api/file/lossy%20%2F1/image.webp"]').first()).toBeAttached();
    await reader.locator(".reader-host").press("ArrowLeft");
    await expect(pageCount(reader)).toHaveText("2 / 11");
    await reader.getByRole("button", { name: "返回图片详情" }).click();
    await expect(page.locator(".counter-current")).toHaveText("3");
    expect(errors).toEqual([]);
  });

  test("help, browser back and reopening release the reader cleanly", async ({ page }) => {
    const { errors } = await setupGallery(page);
    const reader = await openReader(page);
    await reader.getByRole("button", { name: "操作说明" }).click();
    await expect(reader.locator(".reader-help")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(reader.locator(".reader-help")).toHaveCount(0);
    await expect(reader).toBeVisible();
    await page.goBack();
    await expect(reader).toHaveCount(0);
    await expect(page.locator(".viewer-container")).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
    await openReader(page);
    await expect(pageCount(reader)).toHaveText("1 / 12");
    expect(errors).toEqual([]);
  });

  test("slider jumps and vertical scrolling synchronize the selected image", async ({ page }) => {
    const { errors } = await setupGallery(page);
    const reader = await openReader(page);
    await reader.getByRole("slider", { name: "阅读进度" }).evaluate((slider) => {
      slider.value = "9";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(pageCount(reader)).toHaveText("9 / 12");
    await reader.getByLabel("阅读模式").selectOption("scroll");
    await expect(pageCount(reader)).toHaveText("9 / 12");
    await reader.locator(".mv-main").evaluate((main) => main.scrollTo({ top: 0, behavior: "instant" }));
    await expect(pageCount(reader)).toHaveText("1 / 12");
    await reader.getByRole("button", { name: "返回图片详情" }).click();
    await expect(page.locator(".counter-current")).toHaveText("1");
    expect(errors).toEqual([]);
  });

  test("narrow screens keep toolbar and progress controls inside the viewport", async ({ page }) => {
    const { errors } = await setupGallery(page);
    const reader = await openReader(page);
    await page.setViewportSize({ width: 320, height: 568 });
    await expect.poll(async () => {
      const toolbar = await reader.locator(".reader-toolbar").boundingBox();
      const slider = await reader.getByRole("slider", { name: "阅读进度" }).boundingBox();
      return toolbar.x >= 0 && toolbar.x + toolbar.width <= 320 && slider.y + slider.height <= 568;
    }).toBe(true);
    expect(errors).toEqual([]);
  });
});

test("unavailable images show a recoverable empty state", async ({ page }) => {
  const { errors } = await setupGallery(page, { noImages: true });
  await page.locator(".image-card").first().click();
  await page.getByRole("button", { name: "漫画阅读", exact: true }).click();
  const reader = page.getByRole("dialog", { name: "漫画阅读" });
  await expect(reader.getByRole("alert")).toContainText("当前列表没有可阅读的图片");
  await reader.getByRole("button", { name: "返回图片详情" }).click();
  await expect(reader).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("fullscreen exits when closing the reader", async ({ page }) => {
  const { errors } = await setupGallery(page);
  const reader = await openReader(page);
  await reader.getByRole("button", { name: "全屏阅读" }).click();
  await expect(reader.getByRole("button", { name: "退出全屏" })).toBeVisible();
  await reader.getByRole("button", { name: "返回图片详情" }).click();
  await expect(reader).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  expect(errors).toEqual([]);
});
