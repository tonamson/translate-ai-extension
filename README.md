# Translate AI Extension

Chrome Manifest V3 extension for translating web page text with configurable AI providers.

The extension focuses on translating visible text content only. It avoids translating extension UI, icons, SVG content, form controls, and already-translated text nodes to reduce layout breakage and token waste.

## Features

- Translate the current page or only newly detected text.
- Pick a page region and continuously translate lazy-loaded content inside it.
- Replace original text in place to preserve the page layout.
- Track translation progress by text-block batches, for example `Translating 1/21 (210 blocks)`.
- Pause an active translation from the on-page progress indicator.
- Restore translated text back to the original page text.
- Configure API provider, endpoint, model, API key, and target language from the popup.

## Supported API Providers

- OpenAI-compatible chat completions API
- Anthropic messages API

The OpenAI-compatible default endpoint is:

```text
https://api.stepfun.ai/v1
```

For OpenAI-compatible providers, the extension sends requests to:

```text
{baseUrl}/chat/completions
```

For Anthropic, it sends requests to:

```text
{baseUrl}/messages
```

The model is user-configured in the extension popup. The API key is stored by the extension in Chrome storage.

## Repository Layout

```text
public/
  manifest.json        Chrome extension manifest
  logo.png             Extension logo and floating action button image
  icons/               Browser action icons

src/background/
  index.ts             MV3 service worker, API routing, tab status

src/content/
  index.ts             Page UI, text replacement, region watch, progress, pause
  domText.ts           Visible text-node collection and filtering

src/popup/
  index.html           Popup shell
  main.ts              Settings UI and page commands
  styles.css           Popup styles

src/shared/
  ai.ts                Provider integrations and prompt/response validation
  chunking.ts          Text item chunking
  settings.ts          Settings defaults and storage
  translationDecision.ts
  types.ts

src/test/
  *.test.ts            Vitest coverage for API, content, popup, settings, chunking
```

## Development

Requirements:

- Node.js 20+
- Chrome or Chromium

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm run test
npm run typecheck
```

Build the extension:

```bash
npm run build
```

## Loading in Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select the generated `dist/` directory.
5. Open the extension popup and configure provider, endpoint, model, API key, and target language.

After rebuilding, reload the unpacked extension and refresh the target page.

## Translation Flow

1. The content script collects visible, untranslated text nodes.
2. Text is sent to the background service worker in batches of 10 blocks.
3. The background worker calls the configured AI provider.
4. The content script replaces matching text nodes in place.
5. In watch mode, new lazy-loaded text is queued into the same progress counter and translated after the current request finishes.

## Useful Scripts

```bash
npm run test        # Run all Vitest tests
npm run test:watch  # Run tests in watch mode
npm run typecheck   # TypeScript type check
npm run build       # Build extension into dist/
```
