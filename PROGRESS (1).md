# AniTrack — Progress Log

## Current state
- Files imported: manifest.json (v9.0.0), background.js, content.js (v11),
  popup.html/css/js
- icons/ folder is EMPTY — no real 16/48/128 png icons yet (blocks loading
  the extension as-is)
- Version mismatch: manifest.json says 9.0.0, content.js header says v11 —
  not yet reconciled

## Log
### 2026-08-29 — Project setup
- Imported existing files into a proper project structure
- Initialized git, first commit
- Created WORKFLOW.md and this PROGRESS.md
- No feature worked yet — next session picks the first one

### 2026-09-02 — Full QA audit + fix pass (v9/v11/v6 → v12.0.0, reconciled)
This session broke from the normal one-feature cadence at Roshan's explicit
request: ran a hostile QA audit against detection/matching/attachment/
tracking/resume, then fixed everything found in the same session rather than
queuing it feature-by-feature. Real execution evidence (Node) was used for
the pure detection/matching functions, not just code review — see chat log
for the full failure matrix (13 numbered bugs, severities CRITICAL→LOW).

**Fixed this session:**
- Resume never actually seeked the video — `episodePosSec` was written but
  nothing read it back. content.js now applies a pending-resume position
  once per page load; popup.js writes it before opening the tab.
- Fuzzy title matcher (`titleSimilarity` in both background.js and
  popup.js) gave an automatic 0.9 to any substring-contained pair —
  confirmed via direct testing that "Naruto" vs "Boruto: Naruto Next
  Generations" scored 0.9 and would auto-link. Rewrote word-overlap to
  Jaccard (shared/union) and gated the containment bonus by length ratio.
  Added an ambiguity-margin gate (`isConfidentMatch`/`bgFindBestMatch`) so
  auto-linking refuses when two candidates score close together instead of
  guessing — verified against both unambiguous exact-title cases (still
  auto-link correctly) and a genuinely ambiguous case (correctly refused).
- Season collisions: a fuzzy-matched malId shared across seasons could
  silently overwrite a different season's episode progress on the same
  entry. Added season extraction + season-aware dedupe key.
- Wrong-tab/wrong-anime attachment: `findLikelyEntryForHostname`'s
  hostname-only fallback was being used to write per-entry watch time,
  episode position, and completion — meaning an unconfirmed guess could
  attach one anime's playback data to a different anime's entry. Split into
  confident (exact URL) vs. guess; per-entry writes now require confident.
- Storage race: VIDEO_PROGRESS/EPISODE_COMPLETE/checkpoint-alarm each did
  independent read-modify-write on chrome.storage.local with no locking.
  Added a serializing write queue (`withStorageLock`) in background.js.
- CJK titles (JP/CN/KR) had no episode-marker regex and froze at episode
  "1" forever — added 第N話/第N集/N화 patterns.
- Leading "[SiteName]" bracket tags weren't stripped from titles (only
  trailing tags were) — same anime on different sites created duplicate
  library entries. Fixed.
- `looksLikeSiteBranding` false-positive rejected short real titles that
  happened to share letters with the hostname. Added a minimum-length
  guard.
- Manual "Paste a URL" entry had none of auto-detect's safety checks —
  could save literal junk ("File 2771") or a browse-page URL slug ("Action"
  from /browse/action) as the anime title even when a good title was sitting
  right there in the page title. Added junk/generic-word rejection with a
  fallback to page title.
- zoro.to/hianime manual parsing only read episode from `?ep=`, silently
  returning '?' on URLs that encode it in the slug instead. Added fallback.
- Rewatch history (`episodeHistory`, `totalRewatchViews`, rewatch
  notification) was documented/remembered as shipped but wasn't present in
  the actual files — restored in background.js (EPISODE_COMPLETE path) and
  popup.js (manual-save path), both writing through the same shape.
- "Edit/delete wrong attachments" (Roshan-reported): traced to `togglePin`,
  the star-rating handler, `showCompletionModal`, the random-pick "Start
  Watching" button, and — the actual main culprit — `linkEntryToMAL` (MAL
  🔗 linking) all mutating by matching title TEXT across every entry
  instead of the specific entry's unique id. A title collision (see the
  bracket-tag bug above) meant linking/rating/completing/deleting one card
  could silently touch a different duplicate entry. All switched to operate
  on entry.id only. `mergeDuplicateEntries` grouping key made season-aware
  too, so it can't merge different seasons of the same show together.
- "Live tracking doesn't feel like it's tracking" (Roshan-reported):
  episodePosSec/episodeDurationSec were tracked in storage this whole time
  but never shown on the main Library card — added a media-player-style
  "▶ mm:ss / mm:ss" readout + progress bar per watching entry, plus a
  throttled chrome.storage.onChanged listener so it updates live while the
  popup stays open during playback, not just as a snapshot at popup-open.
- Version strings reconciled to 12.0.0 across manifest.json, popup.html
  badge, and all three JS file headers (were 9.0.0/v11/v6/v9, drifted for
  multiple sessions in violation of WORKFLOW.md Rule 4).

**State:** all three JS files pass `node -c` syntax validation; matcher
fixes verified with real executed test cases (not just code review) against
the exact adversarial pairs from the QA audit.

**Known open item, explicitly deferred:** `saveOrUpdateEntry`'s primary
entry-lookup for NEW saves still keys off title text
(`entries.findIndex(e=>e.title...===key)`), not id — this is the entry
point for auto-detect/manual-save deciding "is this an existing anime or a
new one", and reworking it touches the core save flow broadly enough that
it's being held for a dedicated session rather than folded into this
already-large fix pass.

### 2026-09-02 (later same day) — v12.0.0 → v12.1.0: repo verification + closed remaining identity gap
User reported a runtime `RangeError` at `content.js:256` referencing a
function `updateTrackingState` — cloned the actual GitHub repo
(`roshanrajputssrajput-stack/anitrack-core`) and confirmed via `diff` that
its `content.js`/`background.js`/`popup.js`/`manifest.json` are byte-for-byte
identical to the v12.0.0 files from the session above, and confirmed via
`grep` that `updateTrackingState` does not exist anywhere in the repo
(including a `src/` scaffold mentioned in SOURCE_MAP.md but not actually
present). The crash is not from this codebase — most likely a stale content
script in a tab left open across an extension reload, or Chrome pointed at a
different local folder than this repo. Reported to the user directly rather
than guessed away. Full detail in CHANGELOG_AI.md's 2026-09-02 entry.

Also closed the one identity gap explicitly deferred in the entry above:
`saveOrUpdateEntry` (popup.js, manual save path) now resolves malId+season
identity before falling back to title text, matching the pattern already
used in background.js's auto-detect path. Added a whitelist-status banner
to the manual-save preview, since silently not-whitelisted is the most
likely real cause of "auto-detect isn't working" reports and there was
previously zero UI feedback about it anywhere.

Version bumped to 12.1.0 across all files. See CHANGELOG_AI.md for full
before/after detail per this repo's AGENTS.md change-reporting rules.

## Next
- User needs to confirm what `chrome://extensions` actually shows as the
  unpacked extension's source folder, and hard-refresh any anime tabs that
  were open before the last extension reload, to rule out stale content
  scripts before further blind debugging of "auto-detect not working" /
  "false attachment."
- Full UI redesign per Roshan's Visily mockup (screen-navigation flow:
  Continue Watching list → Add New → Details, replacing the current
  tab-based single-page popup). This is an architecture change, not a
  reskin — scoping questions pending before starting (see chat).
