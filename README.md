# AI Page Translator

Chrome Manifest V3 extension for translating web pages with an OpenAI-compatible API.

## Requirements

- Node.js 20+
- Chrome or Chromium
- OpenAI-compatible API access

## Development

```bash
npm install
npm run test
npm run typecheck
npm run build
```

Load `dist/` as an unpacked extension in Chrome.

## OpenAI-Compatible API

Default endpoint: `https://api.stepfun.ai/v1`

Model: enter the model required by your OpenAI-compatible provider.

Default development API key: `123456`. Change the base URL, model, and key from the extension popup.
