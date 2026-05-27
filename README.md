# Local AI Page Translator

Chrome Manifest V3 extension for translating web pages with local Ollama.

## Requirements

- Node.js 20+
- Chrome or Chromium
- Ollama running locally
- The configured model installed, default `llama3.1`

## Development

```bash
npm install
npm run test
npm run typecheck
npm run build
```

Load `dist/` as an unpacked extension in Chrome.

## Ollama

Default endpoint: `http://localhost:11434`

Default model: `llama3.1`

If Chrome cannot reach Ollama, start Ollama with an origin configuration that allows Chrome extension requests.
