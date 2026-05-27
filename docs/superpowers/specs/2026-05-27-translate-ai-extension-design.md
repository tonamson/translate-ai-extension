# Translate AI Chrome Extension Design

## Goal

Build a Chrome extension that translates web pages into a user-selected target language using a local Ollama model. The default behavior is automatic full-page translation when the extension detects that the page is in a different language from the target language. Users can also translate selected text from an on-page floating action.

## Chosen Approach

Use a Chrome Manifest V3 extension built with Vite and TypeScript.

This gives the project typed message contracts, a predictable build pipeline, and room to grow without adding a heavy UI framework. The popup remains plain HTML/CSS/TypeScript for a compact professional interface. The content script stays framework-free because it needs to operate safely inside arbitrary web pages.

## User Experience

The popup follows the "status plus controls" direction:

- Shows Ollama connection status.
- Shows the detected language for the current page.
- Lets the user choose a target language.
- Lets the user configure Ollama endpoint and model.
- Includes an auto-translate toggle.
- Includes manual `Translate page` and `Restore original` actions.

The primary experience is automatic page translation. When auto-translate is enabled, the extension checks the page language after page load and translates only when the page appears to be foreign relative to the target language.

Selection translation is secondary. When the user selects text, a small floating action appears near the selection. Clicking it translates only that selected text and displays the result in a small overlay without rewriting the full page.

## Architecture

### Content Script

Responsibilities:

- Collect visible text nodes from the current page.
- Produce a page sample for language detection.
- Send translation requests to the service worker.
- Replace translated text back into the original text nodes.
- Preserve original text for restore within the current tab session.
- Show and manage the selection translation floating action and result panel.

The content script avoids translating hidden text, script/style content, form values, and extension-owned UI nodes.

### Service Worker

Responsibilities:

- Own all Ollama API calls.
- Read and write extension settings from Chrome storage.
- Detect page language from a text sample.
- Decide whether translation is needed.
- Chunk large page content into bounded translation requests.
- Return typed results to the content script and popup.
- Track current-tab translation status for popup display.

The service worker is the boundary between page scripts and local AI calls.

### Popup

Responsibilities:

- Display current status for the active tab.
- Let the user update target language, model, endpoint, and auto mode.
- Trigger manual page translation.
- Trigger restore original text.
- Display clear errors when Ollama is unavailable or translation fails.

The popup should be compact, direct, and professional. It should avoid marketing-style layout and keep controls easy to scan.

### Shared Modules

Shared TypeScript modules define:

- Message names and payload types.
- Settings shape and defaults.
- Text chunking helpers.
- Ollama response parsing helpers.
- DOM text filtering predicates that can be unit tested outside Chrome where practical.

## Translation Flow

1. On page load, the content script extracts a representative visible-text sample once.
2. The content script asks the service worker to analyze the page.
3. The service worker sends the sample to Ollama with a strict JSON-output prompt.
4. Ollama returns the detected language, confidence, whether the page is foreign, and whether translation should run.
5. If auto-translate is enabled and translation is needed, the content script sends visible text-node batches for translation.
6. The service worker chunks requests, calls Ollama, parses JSON translation results, and returns translated strings.
7. The content script replaces the matching text nodes and reports progress.
8. The popup reflects the latest status for the active tab.

If the page is already in the target language, or the AI determines that translation is unnecessary, no DOM text is changed.

## Selection Translation Flow

1. The user selects text on the page.
2. The content script shows a floating action near the selection.
3. The user clicks the action.
4. The selected text is sent to the service worker.
5. The service worker translates it through Ollama.
6. The content script shows the translated result in a small overlay.

This flow does not mutate the underlying page content.

## Ollama Integration

Default settings:

- Endpoint: `http://localhost:11434`
- Model: configurable, with initial default `llama3.1`
- Target language: Vietnamese
- Auto translate: enabled

Requests use Ollama's local HTTP API from the service worker. Prompts require JSON-only responses so the extension can parse results deterministically. If parsing fails, the service worker retries once with a stricter repair prompt. If parsing still fails, the user sees a clear error and the page is left unchanged.

Users are responsible for running Ollama locally and having the configured model available.

## Error Handling

- If Ollama is unreachable, show `Ollama unavailable` in the popup and skip page mutation.
- If language detection fails, do not auto-translate; allow manual retry.
- If a translation chunk fails, keep original text for that chunk and report partial failure.
- If a page has very little visible text, mark it as `Not enough text to detect`.
- If restore is requested, replace translated nodes with the originals stored in the tab session.

The extension should prefer leaving the page unchanged over applying uncertain or malformed translations.

## Testing Strategy

Use Vitest for unit tests around pure logic:

- Text chunking respects size limits and preserves item order.
- Ollama JSON parsing accepts valid responses and rejects malformed ones.
- Language-decision logic only translates when auto mode is enabled and the page differs from the target language.
- Text-node filtering excludes script/style/hidden/extension UI content.
- Message payload helpers produce expected request and response shapes.

Manual verification:

- Run the build.
- Load the generated extension as an unpacked Chrome extension.
- Confirm popup settings persist.
- Confirm auto-translation triggers on a foreign-language page.
- Confirm no translation occurs when the page is already in the target language.
- Confirm selected text translation opens the overlay and does not rewrite the page.
- Confirm restore returns translated page text to the original text.

## Out of Scope For First Version

- Cloud translation providers.
- Account systems or remote sync.
- Full React popup UI.
- Translating images, canvas, video captions, PDF viewers, or shadow DOM-heavy apps.
- Persistent per-site translation memory.
- Multi-model benchmarking or streaming UI.
