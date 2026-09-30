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

async function revealReaderControls(reader) {
  const main = reader.locator(".mv-main");
  const bounds = await main.boundingBox();
  await main.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  await expect(reader.locator(".reader-toolbar")).toBeVisible();
}

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
    await expect(reader.getByLabel("阅读方向")).toHaveCount(0);
    await expect(reader.getByRole("option", { name: "从右向左" })).toHaveCount(0);
    await expect(pageCount(reader)).toHaveText("5 / 12");
    await reader.getByLabel("阅读模式").selectOption("page");
    await expect(reader.getByLabel("阅读方向")).toHaveValue("ltr");
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
    await expect(reader.locator('.mv-page-slot[data-slot="0"] img').first()).toHaveAttribute("src", /^blob:/);
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

test("immersive fullscreen hides reader chrome and exits when closing", async ({ page }) => {
  await page.addInitScript(() => {
    const originalRequest = Element.prototype.requestFullscreen;
    Element.prototype.requestFullscreen = function (options) {
      window.fullscreenRequestOptions = options;
      return originalRequest.call(this, options);
    };
  });
  const { errors } = await setupGallery(page);
  const reader = await openReader(page);
  await reader.getByRole("button", { name: "全屏阅读" }).click();
  await expect(reader).toHaveClass(/is-immersive/);
  await expect(reader.locator(".reader-toolbar")).toBeHidden();
  await expect(reader.locator(".mv-footer")).toBeHidden();
  const bounds = await reader.locator(".mv-container").boundingBox();
  expect(bounds.y).toBe(0);
  expect(bounds.height).toBe(await page.evaluate(() => innerHeight));
  expect(await page.evaluate(() => window.fullscreenRequestOptions)).toEqual({ navigationUI: "hide" });
  await revealReaderControls(reader);
  await expect(reader.getByRole("button", { name: "退出全屏" })).toBeVisible();
  await reader.getByRole("button", { name: "退出全屏" }).click();
  await expect(reader).not.toHaveClass(/is-immersive/);
  await expect(reader.locator(".reader-toolbar")).toBeVisible();
  await expect(reader.locator(".mv-footer")).toBeVisible();
  await reader.getByRole("button", { name: "全屏阅读" }).click();
  await expect(reader.locator(".reader-toolbar")).toBeHidden();
  await revealReaderControls(reader);
  await reader.getByRole("button", { name: "返回图片详情" }).click();
  await expect(reader).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  expect(errors).toEqual([]);
});

test.describe("phone immersive mode", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  async function configureOrientation(page, { rejectLock = false, disableFullscreen = false, disableOrientation = false } = {}) {
    await page.addInitScript(({ reject, disable, missingOrientation }) => {
      window.orientationLocks = [];
      window.orientationUnlocks = 0;
      Object.defineProperty(screen.orientation, "type", { configurable: true, get: () => "portrait-primary" });
      screen.orientation.lock = async (orientation) => {
        window.orientationLocks.push(orientation);
        if (reject) throw new DOMException("Orientation unavailable", "NotSupportedError");
      };
      screen.orientation.unlock = () => { window.orientationUnlocks += 1; };
      if (missingOrientation) screen.orientation.lock = undefined;
      if (disable) Element.prototype.requestFullscreen = undefined;
    }, { reject: rejectLock, disable: disableFullscreen, missingOrientation: disableOrientation });
  }

  test("native fullscreen keeps portrait and releases its orientation lock on exit", async ({ page }, testInfo) => {
    await configureOrientation(page);
    const { errors } = await setupGallery(page);
    const reader = await openReader(page, 3);
    await reader.getByRole("button", { name: "全屏阅读" }).click();
    await expect(reader).toHaveClass(/controls-hidden/);
    await expect.poll(() => page.evaluate(() => window.orientationLocks)).toEqual(["portrait-primary"]);
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains("manga-reader"))).toBe(true);
    await expect(pageCount(reader)).toHaveText("3 / 12");
    const bounds = await reader.locator(".mv-container").boundingBox();
    expect(bounds.y).toBe(0);
    expect(bounds.height).toBeGreaterThan(bounds.width);
    await captureReader(page, reader, testInfo.outputPath("portrait-immersive.png"));
    await page.evaluate(() => document.exitFullscreen());
    await expect(reader).not.toHaveClass(/is-immersive/);
    await expect(reader.locator(".reader-toolbar")).toBeVisible();
    expect(await page.evaluate(() => window.orientationUnlocks)).toBe(1);
    await reader.getByRole("button", { name: "返回图片详情" }).click();
    expect(await page.evaluate(() => window.orientationUnlocks)).toBe(1);
    expect(errors).toEqual([]);
  });

  test("closing native fullscreen releases the lock and fullscreen element", async ({ page }) => {
    await configureOrientation(page);
    const { errors } = await setupGallery(page);
    const reader = await openReader(page);
    await reader.getByRole("button", { name: "全屏阅读" }).click();
    await expect.poll(() => page.evaluate(() => window.orientationLocks.length)).toBe(1);
    await page.touchscreen.tap(195, 420);
    await expect(reader.locator(".reader-toolbar")).toBeVisible();
    await reader.getByRole("button", { name: "返回图片详情" }).click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
    expect(await page.evaluate(() => window.orientationUnlocks)).toBe(1);
    expect(errors).toEqual([]);
  });

  for (const options of [{ rejectLock: true }, { disableFullscreen: true }, { disableOrientation: true }]) {
    const reason = options.rejectLock ? "orientation lock is rejected" : options.disableFullscreen ? "native fullscreen is unavailable" : "orientation API is unavailable";
    test(`falls back to portrait immersion when ${reason}`, async ({ page }) => {
      await configureOrientation(page, options);
      const { errors } = await setupGallery(page);
      const reader = await openReader(page, 3);
      await reader.getByRole("button", { name: "全屏阅读" }).click();
      await expect(reader).toHaveClass(/controls-hidden/);
      await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
      const bounds = await reader.locator(".mv-container").boundingBox();
      expect(bounds.y).toBe(0);
      expect(bounds.height).toBe(844);
      await expect(pageCount(reader)).toHaveText("3 / 12");
      await page.keyboard.press("Tab");
      await expect(reader.locator(".reader-toolbar")).toBeVisible();
      await expect(reader.locator(".reader-heading")).toContainText("浏览器栏可能仍然显示");
      await reader.getByRole("button", { name: "退出全屏" }).click();
      await expect(reader).not.toHaveClass(/is-immersive/);
      await expect(reader.locator(".reader-toolbar")).toBeVisible();
      expect(await page.evaluate(() => window.orientationUnlocks)).toBe(0);
      expect(errors).toEqual([]);
    });
  }

  test("scroll mode hides direction controls and taps toggle immersive menus", async ({ page }) => {
    await configureOrientation(page, { disableFullscreen: true });
    const { errors } = await setupGallery(page);
    const reader = await openReader(page);
    await reader.getByLabel("阅读方向").selectOption("rtl");
    await reader.getByLabel("阅读模式").selectOption("scroll");
    await expect(reader.getByLabel("阅读方向")).toHaveCount(0);
    await expect(reader.getByRole("slider", { name: "阅读进度" })).not.toHaveClass(/mv-rtl-slider/);
    await expect(reader.locator(".mv-loading-screen")).toHaveCSS("opacity", "0");
    await reader.getByRole("button", { name: "全屏阅读" }).click();
    await expect(reader.locator(".reader-toolbar")).toBeHidden();
    await page.touchscreen.tap(195, 420);
    await expect(reader.locator(".reader-toolbar")).toBeVisible();
    await expect(reader.getByLabel("阅读方向")).toHaveCount(0);
    await page.touchscreen.tap(195, 420);
    await expect(reader.locator(".reader-toolbar")).toBeHidden();
    await expect(reader.locator(".mv-footer")).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(reader).not.toHaveClass(/is-immersive/);
    await expect(reader).toBeVisible();
    await reader.getByLabel("阅读模式").selectOption("page");
    await expect(reader.getByLabel("阅读方向")).toHaveValue("rtl");
    expect(errors).toEqual([]);
  });
});

test.describe("local image cache", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  async function openCacheFixture(page, options) {
    const imageRequests = [];
    await page.addInitScript((configuration) => {
      window.readerFixture = configuration;
      if (configuration.disableDatabase) {
        Object.defineProperty(window, "indexedDB", { value: undefined });
      }
    }, { entries: makeEntries(3), ...options });
    await page.route("**/api/file/**", async (route) => {
      imageRequests.push(route.request().url());
      await route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="#94b2d8"/></svg>'
      });
    });
    await page.goto("/tests/fixtures/manga-reader.html");
    const reader = page.getByRole("dialog", { name: "漫画阅读" });
    await expect(reader.getByRole("slider", { name: "阅读进度" })).toBeVisible();
    return { reader, imageRequests };
  }

  test("reads IndexedDB without file requests and reopens offline", async ({ page }) => {
    const { reader, imageRequests } = await openCacheFixture(page, { seedCache: true });
    await expect(reader.locator('.mv-page-slot[data-slot="0"] img')).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => reader.locator('.mv-page-slot[data-slot="0"] img').evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
    await page.context().setOffline(true);
    await reader.getByLabel("阅读方向").selectOption("ltr");
    await reader.getByLabel("阅读模式").selectOption("scroll");
    await expect(pageCount(reader)).toHaveText("1 / 3");
    await reader.getByRole("button", { name: "返回图片详情" }).click();
    expect(await page.evaluate(() => window.revokedImageUrls.length)).toBe(3);
    await page.getByRole("button", { name: "重新打开" }).click();
    await expect(reader.getByRole("slider", { name: "阅读进度" })).toBeVisible();
    await expect(reader.locator('.mv-page-slot[data-slot="0"] img')).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => reader.locator('.mv-page-slot[data-slot="0"] img').evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
    expect(imageRequests).toEqual([]);
  });

  test("reuses gallery Blob URLs even when IndexedDB is unavailable", async ({ page }) => {
    const { reader, imageRequests } = await openCacheFixture(page, { reuseBlobs: true, disableDatabase: true });
    await expect(reader.locator('.mv-page-slot[data-slot="0"] img')).toHaveAttribute("src", /^blob:/);
    await reader.getByLabel("阅读方向").selectOption("ltr");
    await reader.getByRole("button", { name: "返回图片详情" }).click();
    expect(await page.evaluate(() => window.revokedImageUrls)).toEqual([]);
    await page.getByRole("button", { name: "重新打开" }).click();
    await expect(reader.getByRole("slider", { name: "阅读进度" })).toBeVisible();
    await expect.poll(() => reader.locator('.mv-page-slot[data-slot="0"] img').evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
    expect(imageRequests).toEqual([]);
  });

  test("only missing images fall back to the file API", async ({ page }) => {
    const { reader, imageRequests } = await openCacheFixture(page, {});
    await expect(reader.locator('.mv-page-slot[data-slot="0"] img')).toHaveAttribute("src", "/api/file/lossy%20%2F1/image.webp");
    await expect.poll(() => imageRequests.length).toBe(3);
    await expect.poll(() => reader.locator('.mv-page-slot[data-slot="0"] img').evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
  });

  test("mixed cache hits request only the uncached file", async ({ page }) => {
    const { reader, imageRequests } = await openCacheFixture(page, { seedCache: true, seedCacheCount: 2 });
    await expect(reader.locator('.mv-page-slot[data-slot="0"] img')).toHaveAttribute("src", /^blob:/);
    await expect(reader.locator('.mv-page-slot[data-slot="1"] img')).toHaveAttribute("src", /^blob:/);
    await expect(reader.locator('.mv-page-slot[data-slot="2"] img')).toHaveAttribute("src", "/api/file/original-3/image.png");
    await expect.poll(() => imageRequests.length).toBeGreaterThan(0);
    expect(imageRequests.every((source) => source.endsWith("/api/file/original-3/image.png"))).toBe(true);
  });
});

test.describe("touch scrolling", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  async function waitForScrollIdle(main) {
    let previous = -1;
    let stableSamples = 0;
    await expect.poll(async () => {
      const current = await main.evaluate((element) => element.scrollTop);
      stableSamples = Math.abs(current - previous) < 1 ? stableSamples + 1 : 0;
      previous = current;
      return stableSamples;
    }, { intervals: [50], timeout: 5000 }).toBeGreaterThanOrEqual(4);
    return previous;
  }

  async function swipeUp(page, session, main, horizontalPosition) {
    const bounds = await main.boundingBox();
    const positionX = bounds.x + bounds.width * horizontalPosition;
    const startY = bounds.y + bounds.height * 0.8;
    const endY = bounds.y + bounds.height * 0.3;
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: positionX, y: startY }]
    });
    for (let step = 1; step <= 24; step += 1) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: positionX, y: startY + (endY - startY) * step / 24 }]
      });
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    return waitForScrollIdle(main);
  }

  test("immersive vertical swipes scroll without accidentally revealing menus", async ({ page }) => {
    await page.addInitScript(() => { Element.prototype.requestFullscreen = undefined; });
    const { errors } = await setupGallery(page);
    const reader = await openReader(page);
    await reader.getByLabel("阅读模式").selectOption("scroll");
    await expect(reader.locator(".mv-loading-screen")).toHaveCSS("opacity", "0");
    await reader.getByRole("button", { name: "全屏阅读" }).click();
    await expect(reader.locator(".reader-toolbar")).toBeHidden();
    const session = await page.context().newCDPSession(page);
    try {
      const main = reader.locator(".mv-main");
      const afterFirstSwipe = await swipeUp(page, session, main, 0.5);
      const afterSecondSwipe = await swipeUp(page, session, main, 0.5);
      expect(afterFirstSwipe).toBeGreaterThan(100);
      expect(afterSecondSwipe).toBeGreaterThan(afterFirstSwipe + 100);
      await expect(reader.locator(".reader-toolbar")).toBeHidden();
      await expect(reader.locator(".mv-footer")).toBeHidden();
      expect(errors).toEqual([]);
    } finally {
      await session.detach();
    }
  });

  for (const [position, horizontalPosition] of [["center", 0.5], ["left", 0.15], ["right", 0.85]]) {
    test(`repeated vertical swipes keep scrolling over the ${position} of the image`, async ({ page }) => {
      const { errors } = await setupGallery(page);
      const reader = await openReader(page);
      await reader.getByLabel("阅读模式").selectOption("scroll");
      await expect(reader.locator(".mv-scroll-mode")).toBeVisible();
      await expect(reader.locator(".mv-loading-screen")).toHaveCSS("opacity", "0");
      const main = reader.locator(".mv-main");
      const session = await page.context().newCDPSession(page);
      try {
        const afterFirstSwipe = await swipeUp(page, session, main, horizontalPosition);
        expect(afterFirstSwipe).toBeGreaterThan(100);
        const afterSecondSwipe = await swipeUp(page, session, main, horizontalPosition);
        expect(afterSecondSwipe, `second swipe after scrolling to ${afterFirstSwipe}px`).toBeGreaterThan(afterFirstSwipe + 100);
        const afterThirdSwipe = await swipeUp(page, session, main, horizontalPosition);
        expect(afterThirdSwipe).toBeGreaterThan(afterSecondSwipe + 100);
        expect(errors).toEqual([]);
      } finally {
        await session.detach();
      }
    });
  }
});
