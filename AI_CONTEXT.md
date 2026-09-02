# AniTrack — AI Context / Handoff

> This file is the machine-readable project handoff for future AI coding agents. Read it before making changes. GitHub is the source of truth for the actual implementation; this document records project intent, confirmed behavior, known bugs, deferred work, QA expectations, and design direction.

## 1. Project identity

- Project: **AniTrack**
- Type: existing Chrome extension (Manifest V3)
- Repository: `roshanrajputssrajput-stack/anitrack-core`
- Default branch: `main`
- Current repository implementation version: **12.0.0**
- This must remain **one extension**. Do not create a replacement extension or parallel project.
- Philosophy: **A beautiful broken extension is worse than an ugly working extension.**

## 2. Source-of-truth rule

Use the repository files as the implementation source of truth. Do not assume a feature exists because an old prompt, screenshot, README statement, or conversation says it exists. Verify the actual code.

Before changing code:
1. Inspect the repository tree.
2. Read `PROGRESS.md` and `WORKFLOW.md`.
3. Find the real files/functions implementing the requested behavior.
4. Understand the current data flow before editing.
5. Make the smallest safe change.
6. Test the change and relevant regression paths.
7. Update documentation/version only when appropriate.
8. Report confirmed facts separately from assumptions and plans.

Never blindly rewrite working files.

## 3. Current implementation layout

The repository currently contains the main extension files:

- `manifest.json` — MV3 manifest, permissions, icons, service worker/content/popup wiring.
- `background.js` — large service-worker implementation containing detection/matching/attachment, storage operations, MAL integration, notifications/alarms, tracking sessions and related logic.
- `content.js` — page-side detection signals, video playback tracking, player observation and resume seeking.
- `popup.html` — popup markup and navigation/UI structure.
- `popup.css` — popup styling.
- `popup.js` — popup behavior, library UI, saving/editing/linking, stats/history and related UI logic.
- `icons/` — extension icons and mascot assets.
- `src/` — small scaffold/experimental source structure currently present in the repository. Do not assume it replaces the root implementation; inspect manifest/build wiring before changing architecture.
- `PROGRESS.md` — chronological development and QA log.
- `WORKFLOW.md` — project working rules.
- `README.md` — current feature/structure summary.

## 4. What AniTrack is intended to do

AniTrack tracks anime watching and manga reading history. It can auto-detect content from whitelisted streaming/reader sites or accept manual additions.

### Detection

Detection may use:
- page title
- `og:title`
- `<h1>`
- schema.org JSON-LD, especially `VideoObject` / `TVEpisode`
- `og:episode`
- video/player signals
- iframe signals

Many streaming sites place the real player in an iframe. Detection therefore needs to score signals across frames rather than trusting whichever frame happens to contain a `<video>` element.

Detection must tolerate reasonable:
- punctuation differences
- whitespace/case differences
- season labels
- spelling/formatting variation
- URL and page-title noise
- site branding
- title variants
- Japanese/Romaji and other alternate titles where metadata supports them
- episode markers and unusual episode numbering
- CJK episode markers such as `第N話`, `第N集`, and `N화`

It must **not** become an over-fuzzy matcher that links similarly named anime incorrectly.

### Anime vs manga

Anime and manga are separate content types with separate libraries/storage/statistics. Manga reader pages must not be sent through anime-only MAL/Jikan matching.

### Metadata matching

The implementation uses Jikan + AniList for anime metadata/matching. Matching should use normalized/alternate titles and conservative fuzzy matching. Ambiguous matches should remain unlinked rather than guessing. Async metadata responses must not overwrite newer state with stale results.

### Watch tracking

Real `<video>` playback should be tracked event-by-event rather than treating wall-clock time as watch time. Paused/seeking/buffering periods should not inflate watched time. Site-level fallback logic may cover players that cannot expose a normal video element.

Episode completion is percentage/time-remaining based rather than a fixed duration guess. Completion must fire once per episode.

### Live position

While an episode is actively playing, the library can show the current episode position and duration with a media-player-style `▶ mm:ss / mm:ss` display and progress bar. Popup updates are throttled rather than continuously writing/rendering every event.

### Resume

Resume means **Continue where I stopped**.

Required flow:
1. Save the episode URL.
2. Save the playback timestamp.
3. Resume opens the saved episode URL.
4. Wait for the player/video and metadata.
5. Seek to the saved timestamp when possible.
6. Show an appropriate opening/seeking state.
7. Fail gracefully if the player or timestamp cannot be used.

Do not claim Resume works merely because a timestamp is stored. Verify that the timestamp is actually consumed and applied to the player.

Guard against trivial timestamps and positions near the end when appropriate. Resume must be safe across refresh, popup reopen, browser restart, slow loading, slow network, dynamic player replacement, iframe players, different sources, SPA navigation, invalid timestamps, and missing URLs.

### Rewatch history

Each anime episode can have per-episode watch history including watch count and first/last watched information. Rewatch detection should work for both auto-completion and manual-save paths and use the same data shape so counts do not drift.

### Library management

Existing functionality includes:
- separate Anime and Manga libraries
- watching/completed/dropped/on-hold/plan-to-watch statuses
- priority flags
- tags
- sub/dub/type/season data
- notes
- ratings
- MAL OAuth/sync/import/resync behavior
- new-season watcher
- next-episode notifier
- per-site/content-type time statistics
- backup/restore with local JSON
- history and episode-level tracking

Protect these features during bug fixes and UI work.

## 5. Confirmed fixes already present in v12.0.0

According to the current `PROGRESS.md`, the 2026-09-02 QA/fix pass addressed:

- Resume seek path: saved `episodePosSec` is now applied by `content.js` once per page load after metadata is available; popup writes the position before opening the tab.
- Unsafe substring fuzzy matching: title similarity was changed from an overly generous containment score to Jaccard-style word overlap plus a length-ratio-gated containment bonus.
- Ambiguous matching: confidence-margin checks prevent automatic linking when close candidates compete.
- Season collisions: season extraction and season-aware dedupe prevent one season from overwriting another.
- Wrong-tab/wrong-anime attachment: hostname-only guesses no longer perform sensitive per-entry writes; those writes require confident attachment.
- Storage races: relevant read-modify-write paths were serialized with a storage lock/write queue.
- CJK episode markers: added `第N話`, `第N集`, and `N화` patterns.
- Leading bracketed site tags: stripping now handles leading site tags as well as trailing tags.
- Short-title/site-branding false positives: added a minimum-length guard.
- Manual URL parsing safety: rejects generic/junk/browse-page titles and falls back to a better page title when available.
- zoro.to/hianime episode parsing: URL slug fallback added when `?ep=` is absent.
- Rewatch history: restored in actual background/popup paths with a shared shape.
- Wrong-entry mutation: pin/rating/completion/delete/random-pick/MAL-link paths were changed to operate on entry IDs rather than matching title text across the library.
- Duplicate merge grouping: season-aware grouping added.
- Live tracking visibility: per-episode position/duration/progress was surfaced on library cards with a throttled storage-change listener.
- Version drift: manifest/UI/JS version strings were reconciled to 12.0.0.

These are documented as completed fixes, but future agents must still regression-test them rather than assuming they can never regress.

## 6. Known open/deferred issue

`saveOrUpdateEntry` still has a deliberately deferred primary lookup for deciding whether a new manual/auto save is an existing entry or a new one. The current lookup keys off normalized title text rather than entry ID. Do not casually rewrite this core save flow. Treat it as a dedicated bug/fix task with regression testing for duplicates, seasons, rewatch history, progress, ratings, pins, MAL links, and existing data.

## 7. Important failure patterns / QA targets

Known/reported failure classes include:

1. Anime detection completely fails.
2. Small title differences or noisy page titles cause the wrong anime to be selected.
3. Detection succeeds but attachment/linking selects the wrong library entry.
4. Wrong attachment produces the wrong image, metadata, episode or progress.
5. Streaming player detection fails because the real player is dynamic or inside an iframe.
6. Resume stores a timestamp but fails to seek.
7. Completion/progress is wrong after seeking, buffering, pausing, short videos, long videos, or duplicate events.
8. Storage races cause progress/history loss or inconsistent state.
9. API failures or stale responses produce wrong metadata.
10. Duplicate/season entries collide.
11. Backup/restore can encounter malformed, old, missing, or duplicate data.
12. Edit/delete/rating/link actions can target the wrong entry if they identify records by title instead of unique ID.

A canonical real-world detection regression is a noisy title such as **`Renegade Immortal Ogxqp`**, which must resolve to the correct anime without making similarly named shows match accidentally.

## 8. Aggressive QA matrix

For every meaningful feature, test both happy paths and hostile conditions:

- empty library
- one entry
- large library
- duplicate titles
- same title across seasons
- long titles
- punctuation-heavy titles
- Unicode/CJK titles
- Romaji/alternate-title variants
- similarly named anime
- site-branding prefixes/suffixes
- malformed URLs
- missing URLs
- missing images/metadata
- API/network failure
- stale API response
- slow network
- offline behavior
- dynamic/late player creation
- cross-origin iframe player
- multiple video elements
- player replacement
- SPA navigation
- rapid/repeated clicks
- popup reopen
- page refresh
- browser restart
- invalid timestamp
- zero/negative timestamp
- timestamp beyond duration
- timestamp near episode end
- missing duration
- very short video
- very long video
- seeking forward/backward
- pause/resume
- buffering
- multiple tabs/sources
- unusual episode numbers
- completion event duplication
- restore of old/malformed backup data

Never call a bug fixed after only one successful test.

## 9. Minimal diagnostics

Where useful, diagnostics may record only minimal non-sensitive state such as:
- detection attempted/succeeded/failed
- normalization result category
- candidate match confidence category
- attachment success/failure category
- metadata failure category
- source/site category
- episode parsing success/failure

Suggested event categories: `DETECTED`, `NORMALIZED`, `MATCHED`, `ATTACHED`, `FAILED_DETECTION`, `FAILED_MATCH`, `FAILED_METADATA`, `FAILED_ATTACHMENT`, `LOW_CONFIDENCE`.

Do **not** collect unnecessary browsing history, cookies, passwords, authentication tokens, private page content, or unrelated personal data.

## 10. UI direction — after reliability

UI redesign is important but comes after core reliability.

Target aesthetic:
- real anime/manga extension, not a generic AI dashboard
- neutral dark foundation
- restrained purple accent
- semantic status colors
- tasteful anime artwork/covers
- compact, readable layouts
- mascot used sparingly
- no excessive purple
- no giant decorative elements
- no unnecessary animation

Popup target is roughly 420px wide and popup-first.

Popup priority:
1. Continue Watching first
2. maximum 3 initial items
3. Watching section open by default
4. card hierarchy: Cover → Title → Episode/Progress → Status → Resume
5. show `Continue from mm:ss` when a timestamp exists
6. secondary information belongs in Details

Desktop/library organization target:
- Almost Done
- Airing Now
- Watching
- On Hold
- Completed
- Dropped

Manga, New, History, Stats, Add, Settings, and MAL screens should preserve their existing functionality and use the same design system.

Motion should be restrained and functional: subtle hover/press feedback, smooth section/modal transitions, progress updates, and small loading/success/error transitions. Avoid animation that interferes with reading or playback controls.

## 11. Future work

Possible later work includes a stronger UI/navigation architecture, autonomous QA/testing assistance, richer social/community features, and public-launch hardening. These are explicitly lower priority than core reliability.

Do not implement major future/social features while critical detection, attachment, tracking, Resume, data integrity, or regression problems remain.

## 12. Version/data rules

- Keep AniTrack as one extension.
- Preserve existing `chrome.storage.local` data.
- Never wipe user data as part of an update.
- Use safe migration if storage schema changes.
- Backup/restore must remain compatible with old data where practical.
- Keep manifest and in-code versions synchronized for shipped changes.

## 13. Agent operating procedure

**INSPECT → PLAN → MODIFY → TEST → REPORT**

### INSPECT
Read the actual repository. Identify the exact implementation path. Check recent `PROGRESS.md` entries and existing tests/validation.

### PLAN
State the smallest change that addresses the confirmed bug/feature. Identify possible regressions.

### MODIFY
Edit only necessary files. Preserve unrelated behavior and data structures.

### TEST
Run syntax/static tests and focused behavioral tests. For detection/matching, include adversarial similar-title cases. For attachment, verify the actual entry ID and episode/source fields. For Resume, verify the player consumes the saved timestamp. For tracking, verify real playback, seeking, pause, buffering and completion behavior.

### REPORT
Clearly list:
- confirmed problem
- files/functions changed
- behavior changed
- tests actually run
- results
- remaining known issues
- assumptions, if any

Do not claim browser-level behavior was tested if only static/code-level testing was performed.

## 14. Documentation rule

After meaningful work, update `PROGRESS.md` with the actual state. Keep `README.md` describing what the extension actually does today, not aspirational features.

This file is a handoff/context document; it should be updated when project-wide intent, known bugs, architecture, QA expectations, or important completed work changes.
