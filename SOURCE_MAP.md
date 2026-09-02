# AniTrack — Source Map

This document maps the repository's current files to their known role. It is an orientation guide, not a replacement for reading the actual source. Future AI agents MUST inspect the implementation before modifying behavior.

## Source of truth

The actual files in this repository are authoritative. Documentation describes intent and known state; source code determines what is really implemented.

## Root extension implementation

### `manifest.json`
Manifest V3 extension configuration. Defines the extension identity, version, permissions, service worker/content-script wiring, popup, and icon references.

### `background.js`
Primary background/service-worker implementation. Known responsibilities include the detection/matching/attachment pipeline, storage operations, anime metadata integration, MAL integration, tracking/session logic, episode completion and rewatch handling, notifications/alarms, and related library operations. This is currently a large legacy/root implementation; do not assume the `src/` scaffold replaces it.

### `content.js`
Page-side implementation. Known responsibilities include extracting page/frame detection signals, observing/detecting players, real video playback tracking, and applying saved Resume positions after player metadata becomes available.

### `popup.html`
Popup markup and screen/navigation structure.

### `popup.css`
Popup styling and visual layout.

### `popup.js`
Popup behavior and UI logic. Known responsibilities include library rendering, Continue/Resume actions, manual add/save flows, edit/delete/pin/rating/completion actions, MAL linking, history/episode tracker/stat views, and live progress display.

## Assets

### `icons/icon16.png`
16px extension toolbar/icon asset.

### `icons/icon48.png`
48px extension icon asset.

### `icons/icon128.png`
128px extension icon asset.

### `icons/mascot-idle1.png` through `icons/mascot-idle6.png`
Mascot idle animation frames/assets used by the extension UI where applicable.

### `icons/mascot-excited.png`
Mascot excited-state asset.

### `icons/mascot-wave.png`
Mascot wave-state asset.

### `icons/bg-anime.jpg`
Documented as a missing/optional ambient popup background in the current project notes. The extension should degrade gracefully if it is absent. Do not invent or silently replace it without checking the actual tree and UI references.

## `src/` scaffold

The repository also contains a small `src/` structure. It is NOT currently documented as a replacement build architecture. Inspect `manifest.json` and actual imports/build wiring before migrating anything into it.

### `src/background/service-worker.js`
Small background/service-worker scaffold currently present in `src/`.

### `src/content/observer.js`
Small content observer scaffold currently present in `src/`.

### `src/lib/storage-buffer.js`
Small storage-buffer utility scaffold currently present in `src/`.

### `src/popup/popup.html`
Small popup scaffold currently present in `src/`.

## Project documentation

### `README.md`
Current factual feature and structure summary. It should describe shipped behavior, not future plans.

### `AI_CONTEXT.md`
Full AI handoff: project identity, architecture, intended behavior, confirmed v12 fixes, known/deferred bugs, QA matrix, UI direction, data rules, diagnostics rules, and agent workflow.

### `AGENTS.md`
Short non-negotiable instructions for AI coding agents.

### `WORKFLOW.md`
Project development rules: one feature at a time, self-documenting progress, factual README, synchronized versions, and session checklist.

### `PROGRESS.md`
Chronological project log. Contains the 2026-09-02 QA/fix pass, confirmed v12.0.0 changes, testing evidence, and the explicitly deferred `saveOrUpdateEntry` title-keyed lookup.

### `LICENSE`
Repository license.

### `.gitignore`
Git ignore rules. Never commit credentials, private browsing data, local secrets, generated personal data, or backup data merely to help an AI understand the project.

### `.claude/settings.local.json`
Local Claude-related settings file currently present in the repository tree. Treat as configuration, not as source-of-truth documentation. Do not expose secrets or tokens if the file is ever found to contain them.

## Important architecture note

The root files (`background.js`, `content.js`, `popup.js`, etc.) are the implementation that must be treated as authoritative until the manifest/build wiring proves otherwise. The existence of `src/` does not justify moving, deleting, duplicating, or rewriting the root implementation.

## Reliability-critical flow map

Detection:
page/frame signals → title/metadata extraction → cleaning/normalization → anime/manga classification → candidate search → conservative title matching → confidence decision.

Attachment:
selected anime identity → metadata/cover → episode parsing → source URL → timestamp/progress → correct library entry/storage record.

Resume:
saved episode URL + saved timestamp → open URL → wait for player/metadata → seek once when possible → continue/fail gracefully.

Tracking:
real player events → watched-time/progress calculation → throttled persistence → episode completion → history/rewatch/library updates.

Agents must test these stages separately. Successful detection does not prove successful matching or attachment.

## Safety/data rules

- Preserve existing extension identity.
- Preserve existing user data and storage unless a migration is explicitly required and safely implemented.
- Never commit cookies, passwords, tokens, credentials, private browsing history, or personal backup files.
- Do not treat a screenshot, old prompt, or README claim as proof that a feature works.
- Do not claim browser/player behavior was tested when only static or Node-level tests were run.
