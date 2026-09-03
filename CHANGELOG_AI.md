# AniTrack — AI Development Changelog

This file is the mandatory chronological record for AI-assisted development.

## Rules for every AI agent

After any meaningful repository change, update this file in the same change/commit or immediately after it when the platform requires separate commits.

Every entry must contain:

- **Date:** exact date in `YYYY-MM-DD` format.
- **Agent:** AI/tool name if known (for example Claude, Codex, Gemini, ChatGPT); otherwise `Unknown AI agent`.
- **Version:** extension version if changed; otherwise current version.
- **Task:** what was requested.
- **Confirmed problem:** the bug/requirement actually verified before editing.
- **Files changed:** exact repository paths, not vague descriptions.
- **What changed:** concise description of the actual implementation/documentation change.
- **Tests run:** exact tests/commands or behavioral checks actually performed.
- **Results:** pass/fail and important observations.
- **Remaining issues:** anything not fixed or not tested.
- **Assumptions:** only when an assumption was necessary.

Never write that something was tested if it was not actually tested. Never mark a bug fixed based only on intended code behavior.

## Required documentation updates

Agents must also update the relevant project documentation when appropriate:

- `PROGRESS.md` — meaningful development, fixes, QA results, version changes.
- `AI_CONTEXT.md` — project-wide behavior, architecture, known bugs, QA expectations, or important completed fixes that future agents need to know.
- `SOURCE_MAP.md` — when source files, architecture, or critical flow ownership changes.
- `README.md` — only when the user-facing/current feature or setup description changes.
- `AGENTS.md` — only when permanent agent rules change.

Documentation must describe the repository's **actual current state**, not planned work.

## Entry template

Copy this template for each meaningful change:

```text
## YYYY-MM-DD — <short task name>

- Agent: <AI/tool>
- Version: <version>
- Task: <request>
- Confirmed problem: <verified problem>
- Files changed: <exact paths>
- What changed: <actual changes>
- Tests run: <exact tests/checks>
- Results: <pass/fail + observations>
- Remaining issues: <none or list>
- Assumptions: <none or list>
```

## 2026-09-02 — AI handoff documentation foundation

- Agent: ChatGPT
- Version: 12.0.0
- Task: Make the repository easier and safer for future AI agents to inspect and continue.
- Confirmed problem: Future agents needed a compact project handoff, explicit source ownership, and non-negotiable development/testing rules.
- Files changed: `AGENTS.md`, `AI_CONTEXT.md`, `SOURCE_MAP.md`, `README.md`, `CHANGELOG_AI.md`
- What changed: Added AI operating rules, project context, source map, README guidance, and this mandatory AI development changelog.
- Tests run: Repository/documentation verification through GitHub; source behavior was not changed by this documentation pass.
- Results: Documentation files are present on the default branch. Actual source files remain the implementation source of truth.
- Remaining issues: Full source-tree audit and browser-level QA are separate tasks.
- Assumptions: None.

## 2026-09-02 — Repo verification + close remaining title-keyed identity gap

- Agent: Claude
- Version: 12.0.0 → 12.1.0
- Task: User reported a runtime `Uncaught RangeError: Maximum call stack size exceeded` at `content.js:256` inside a function `updateTrackingState`, plus continued reports of "auto-detect not working" and "false attachment" after replacing files with v12.
- Confirmed problem: Cloned `roshanrajputssrajput-stack/anitrack-core` directly (read-only, via `git clone`) and diffed `content.js`, `background.js`, `popup.js`, `manifest.json` byte-for-byte against the v12 files this agent produced in the prior session — all four are IDENTICAL (confirmed via `diff`, zero output). Grepped the entire repo, including a `src/` scaffold mentioned in `SOURCE_MAP.md`, for `updateTrackingState` — zero matches anywhere in the repository. `content.js` in this repo is 172 lines total; the error trace cites line 256, which doesn't exist in this file. **Conclusion: the crash in the user's screenshot is not from any code in this repository.** It is almost certainly a stale content script still running in a tab that was open before the extension was reloaded (Chrome does not re-inject content scripts into already-open tabs on extension reload — this requires refreshing the tab itself, not just reloading the extension), or a different local unpacked-extension folder than this repo. This was reported back to the user directly rather than silently assumed fixed. Was NOT able to verify in a live browser — no browser environment available to this agent.
- Files changed: `popup.js`, `manifest.json`, `content.js` (header only), `background.js` (header only), `popup.html` (badge only), `PROGRESS.md`, this file.
- What changed:
  1. `popup.js` `saveOrUpdateEntry()` — this was the one identity gap explicitly deferred in the prior v12.0.0 session (see the 2026-09-02 v12.0.0 entry below and README.md "Known gaps"). It found "is this an existing anime?" by raw lowercased title text only. Reordered so the Jikan/AniList match (`searchJikan`) resolves first, then the existing-entry lookup uses `malId + season` identity (matching the pattern already used in `background.js`'s `autoDetectFromTab`), falling back to `season + normalized title` only when there's no malId. This is the manual "Save This Episode" / manual URL entry path — a title collision here (two different anime normalizing to the same title string) could previously cause a manual save to silently update the wrong existing entry. The completion-modal lookup inside the same function was also switched from title-text matching to matching the specific entry's `id`.
  2. `popup.js` — added a whitelist-status banner to the "Save This Episode" preview (Add tab). Auto-detect (`background.js`) silently does nothing on a non-whitelisted hostname, with no UI feedback anywhere previously. This is very likely the actual cause behind at least some "auto-detect not working" reports — the site was simply never added to Settings → Auto-Detect Websites. The banner now shows inline with a one-click "Add site" button right where the user is already looking, instead of requiring them to discover the Settings tab.
  3. Version reconciled to 12.1.0 across `manifest.json`, `popup.html` badge, and all three JS file headers, per `WORKFLOW.md`/`AGENTS.md` version-sync rules.
- Tests run: `node -c` syntax validation on `content.js`, `background.js`, `popup.js` (all pass). `python3 -m json.tool` validation on `manifest.json` (valid). Manual read-through of the reordered `saveOrUpdateEntry` control flow for logic correctness. Did NOT run this in a live Chrome instance — no browser environment available. Static/Node-level testing only, consistent with `AGENTS.md`'s requirement not to claim browser-level testing that didn't happen.
- Results: Static checks pass. The `updateTrackingState`/RangeError issue is confirmed NOT present in this repository's code (see Confirmed problem above) — the user needs to verify what's actually loaded in `chrome://extensions` and hard-refresh any tabs that were open before the last reload. "False attachment" — the specific gap this session closes (manual-save title-only lookup) is a plausible contributor but not confirmed as THE cause of what the user is currently seeing, since no reproduction steps or console output were provided for the specific attachment failure.
- Remaining issues:
  - User has not yet confirmed whether the stale-extension theory is correct, or what `chrome://extensions` shows for the unpacked extension's source folder.
  - No specific reproduction steps were obtained for the "auto-detect not working" / "false attachment" reports beyond what's addressed here — if these persist after confirming a clean reload, the next session needs actual console/storage output to diagnose further, not another blind code pass.
  - Full UI redesign (Visily mockup — screen-navigation flow) remains not started, per user's prior message; still pending explicit scoping decision.
- Assumptions: Assumed the user's Chrome is pointed at the same folder as this GitHub repo (unconfirmed — see Remaining issues).

