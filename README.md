# AniTrack

A Chrome extension that tracks anime watching and manga reading history —
auto-detected from whitelisted streaming/reader sites, or added manually.

## AI / developer handoff

**Start here when working on AniTrack:**

- [`AI_CONTEXT.md`](AI_CONTEXT.md) — comprehensive project context, confirmed fixes, known bugs, detection/attachment rules, Resume behavior, QA matrix, UI direction, data-safety rules, and AI workflow.
- [`AGENTS.md`](AGENTS.md) — concise rules for AI coding agents.
- [`PROGRESS.md`](PROGRESS.md) — chronological implementation and QA log.
- [`WORKFLOW.md`](WORKFLOW.md) — development/session rules.

The repository source files are the implementation source of truth. AI agents should inspect the actual code before assuming a feature exists or changing behavior.

## What it does today (v12.1.0)

### Auto-detection
- Reads a whitelisted site's page title / og:title / h1, or (highest
  confidence) schema.org JSON-LD (`VideoObject`/`TVEpisode`) and
  `og:episode` meta when the site publishes it.
- Works across iframes — many players embed in a cross-origin frame with
  no real title of its own; AniTrack scores every frame's signal and picks
  the best one instead of trusting whichever frame happens to have the
  `<video>` tag.
- Splits anime vs. manga automatically: pages with a real `<video>`
  element go to the anime library; page-image "reader" pages go to a
  fully separate manga library (no MAL/Jikan lookups run against manga
  titles — they're anime-only databases).
- Matched against Jikan + AniList (fuzzy title matching, retried on
  network hiccups) to pull cover art, score, episode count, and airing
  status automatically.

### Watch tracking
- Real `<video>` playback is tracked event-by-event (not polled) —
  accumulates actual watched seconds, ignores seeking/buffering/paused
  time, and reports on a throttle (every 10s or 5% progress).
- A site-level fallback (tab focus + idle detection) covers sites where the
  video element isn't reachable (DRM players, etc).
- Episode completion is detected by percentage (95%+ watched, or under 2
  minutes remaining), not a fixed time guess, and fires once per episode.
- **Live position on the library card**: while an episode is actively being
  watched, the card shows a media-player-style `▶ mm:ss / mm:ss` readout
  and progress bar for that specific episode — not just overall series
  progress. Updates live while the popup stays open (throttled to once
  every 4s) rather than only showing a snapshot from when the popup opened.
- **Resume position**: current playback position is saved continuously and
  applied when you resume. Clicking Resume writes the saved position, then
  content.js seeks the video to it once metadata loads on the new page —
  guarded to fire exactly once per page load, and skipped for trivial
  (<10s) or near-the-end (<15s remaining) positions.

### Rewatch detection
- Every episode has its own watch history (times watched, when, how
  long). A saved episode number that's been watched before triggers a
  notification (`🔁 Rewatch detected! Episode 7: this is watch #3`).
- Works whether the episode was auto-tracked (real playback reaching
  completion) or manually saved via the Add tab — both paths write to the
  same `episodeHistory` so counts can't drift apart.
- The library card shows a `🔄 ×N` badge (total extra views across every
  episode, beyond each one's first watch), with a hover tooltip listing
  which specific episodes were rewatched.

### Episode Tracker
- Per-episode breakdown (📊 button on each library card): watch count,
  real time spent on that specific episode, first/last watched dates —
  not just a single lump total for the whole series.
- Shows lifetime watch time and, once an anime is completed, how long it
  took from first tracked to completed (days/months/years).

### Library management
- Separate Anime and Manga tabs/libraries — completely independent
  storage, statuses, and stats. Manga entries never touch MAL/Jikan.
- Status tracking (watching/completed/dropped/on hold/plan to watch),
  priority flags, tags, sub/dub/type, season number, per-anime notes,
  10-star ratings.
- MyAnimeList sync (OAuth): auto-push on every save, bulk import/push,
  and a resync tool that retroactively links older entries that predate
  reliable matching.
- New-season watcher: once a day, checks completed anime for a newly
  released sequel/movie and notifies.
- Next-episode notifier: for currently-airing anime you're watching,
  notifies once the day's broadcast (JST) has actually aired.
- Time-spent stats **split by content type per site** — anime watching
  time and manga reading time on the same domain are tracked and shown
  separately, not blended into one number.
- Backup/restore to a local JSON file, with auto-backup on save.

## File structure
- `manifest.json` — extension manifest (MV3), permissions, icons
- `content.js` — runs on every page; extracts detection signals, tracks
  real video playback, handles resume-seek
- `background.js` — service worker; auto-detect pipeline, MAL OAuth,
  time-tracking sessions, rewatch detection, notifications, alarms
- `popup.js` / `popup.html` / `popup.css` — the extension UI
- `icons/` — toolbar icons + mascot sprite set
- `AI_CONTEXT.md` — detailed AI/developer handoff
- `AGENTS.md` — AI coding-agent rules
- `WORKFLOW.md` — how this project is developed (one feature at a time,
  self-documenting via `PROGRESS.md`)
- `PROGRESS.md` — session-by-session log of what shipped and what's next

## Known gaps
- `icons/bg-anime.jpg` (popup ambient background) isn't included —
  degrades gracefully to a transparent layer without it.
- Rewatch/episode-tracker features are anime-only; manga has no
  equivalent reread tracking yet.
- Manual save/update ("Save This Episode", manual URL entry) now resolves
  identity via MAL ID + season (matching the auto-detect path) instead of
  title text alone, closing the last deferred identity gap from v12.0.0
  — see PROGRESS.md's v12.1.0 entry.
- Auto-linking to MAL now requires either a near-exact match or a clear
  confidence margin over the runner-up candidate (see PROGRESS.md v12
  entry) — ambiguous titles are left unlinked rather than guessed, so some
  previously auto-linked entries may now need a manual 🔗 link.
- The "Save This Episode" preview now shows a warning banner with a
  one-click fix if the current site isn't whitelisted for auto-detect —
  auto-detect silently does nothing on non-whitelisted hostnames, which
  was previously invisible in the UI.
