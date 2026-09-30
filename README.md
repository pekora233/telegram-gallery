# telegram-gallery

This template should help get you started developing with Vue 3 in Vite.

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Vue (Official)](https://marketplace.visualstudio.com/items?itemName=Vue.volar) (and disable Vetur).

## Recommended Browser Setup

- Chromium-based browsers (Chrome, Edge, Brave, etc.):
  - [Vue.js devtools](https://chromewebstore.google.com/detail/vuejs-devtools/nhdogjmejiglipccpnnnanhbledajbpd)
  - [Turn on Custom Object Formatter in Chrome DevTools](http://bit.ly/object-formatters)
- Firefox:
  - [Vue.js devtools](https://addons.mozilla.org/en-US/firefox/addon/vue-js-devtools/)
  - [Turn on Custom Object Formatter in Firefox DevTools](https://fxdx.dev/firefox-devtools-custom-object-formatters/)

## Customize configuration

See [Vite Configuration Reference](https://vite.dev/config/).

## Database

The Worker supports MongoDB and Cloudflare D1. If a D1 binding named `DB` exists, the backend uses D1 first and does not connect to MongoDB.

## Project Setup

```sh
npm install
```

### Compile and Hot-Reload for Development

```sh
npm run dev
```

### Compile and Minify for Production

```sh
npm run build
```

## Manga Reader

Open an image and select the book icon in the detail toolbar to enter manga mode, powered by `@tokagemushi/manga-viewer`. It follows the current gallery order and starts at the selected image. Choose ascending order in the gallery first if the pages should run oldest to newest.

- Switch between right-to-left and left-to-right reading, or paged and vertical-scroll modes. These preferences are saved locally.
- Reading-direction controls only appear in paged mode. Vertical scrolling always follows the top-to-bottom page order, while preserving the direction preference for returning to paged mode.
- Images reuse the gallery's existing Blob URLs or read from the shared IndexedDB image cache before falling back to the remote file API. Switching modes or reopening cached images does not download them again.
- Landscape screens automatically show spreads. Swipe, use arrow keys or Space, double-click/pinch to zoom, and use the bottom slider to jump to a page.
- More images load near the end of the list when the gallery supports infinite loading. Numbered pagination reads the currently loaded gallery page only.
- Return or press Escape to go back to image details at the current reading position. The existing PhotoSwipe viewer remains available.
- Immersive fullscreen removes toolbar space and hides the toolbar, progress slider, and zoom controls. Tap the center to reveal/hide menus, or press Tab to reveal keyboard controls. Escape exits fullscreen before closing the reader.
- On touch screens, native fullscreen locks the orientation captured before entry and releases that lock on exit. If fullscreen or orientation locking is unavailable, page-level immersion is used without forcing rotation; browser/system bars may remain visible in this fallback.

### Browser Tests

```sh
npx playwright install chromium
npm test
```

Tests use mocked gallery and image APIs; no production database or Telegram requests are made. Set `PLAYWRIGHT_CHANNEL=msedge` to use an installed Microsoft Edge instead of bundled Chromium.

Touch regressions use real Chromium touch input and verify repeated vertical swipes over the center and both edges of an image, not just programmatic scroll-position changes.
