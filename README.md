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
- Landscape screens automatically show spreads. Swipe, use arrow keys or Space, double-click/pinch to zoom, and use the bottom slider to jump to a page.
- More images load near the end of the list when the gallery supports infinite loading. Numbered pagination reads the currently loaded gallery page only.
- Return or press Escape to go back to image details at the current reading position. The existing PhotoSwipe viewer remains available.

### Browser Tests

```sh
npx playwright install chromium
npm test
```

Tests use mocked gallery and image APIs; no production database or Telegram requests are made. Set `PLAYWRIGHT_CHANNEL=msedge` to use an installed Microsoft Edge instead of bundled Chromium.
