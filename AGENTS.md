# AniTrack AI Agent Instructions

Read `AI_CONTEXT.md`, `SOURCE_MAP.md`, `PROGRESS.md`, `WORKFLOW.md`, and `CHANGELOG_AI.md` before changing the project.

## Non-negotiable rules

- This is the existing AniTrack extension. Never create a second extension.
- GitHub repository contents are the implementation source of truth.
- Do not invent files, functions, architecture, APIs, or feature status.
- Do not blindly rewrite working code.
- Prefer the smallest safe change.
- Protect existing user data and existing features.
- Follow: **INSPECT → PLAN → MODIFY → TEST → REPORT**.
- Treat detection and attachment as separate reliability problems.
- Do not use title-only guesses for sensitive per-entry writes when confidence is insufficient.
- Do not make anime matching so fuzzy that similarly named anime are linked incorrectly.
- Manga and anime data paths remain separate.
- Do not claim a feature is fixed without testing the failure mode and regression cases.
- Do not claim browser/player behavior was tested when only static or Node tests were run.

## Priority

1. Bug fixes
2. Detection reliability
3. Attachment/link reliability
4. Tracking/progress reliability
5. Resume reliability
6. Data preservation/migration
7. UI redesign
8. Hard QA/security
9. Major future/social features

## Mandatory change reporting

For **every meaningful code, configuration, test, or documentation change**, the AI agent must record the work in `CHANGELOG_AI.md`.

Each entry must give:

- exact date (`YYYY-MM-DD`)
- AI/tool/agent name when known
- version
- requested task
- confirmed problem/requirement
- exact files changed
- what was actually changed
- exact tests/checks actually run
- test results
- remaining known issues or untested areas
- assumptions, if any

Do not use vague statements such as “updated some files.” Name the exact paths and summarize the actual changes.

Documentation must be updated **as needed**, based on what really changed:

- `PROGRESS.md` for meaningful development/fixes/QA/version changes
- `AI_CONTEXT.md` when project-wide behavior, architecture, known issues, QA expectations, or important completed fixes change
- `SOURCE_MAP.md` when file ownership, architecture, or critical flow locations change
- `README.md` when current user-facing behavior/setup changes
- `AGENTS.md` only when permanent agent rules change
- `CHANGELOG_AI.md` for the actual chronological record of every meaningful change

An AI must not silently modify code and leave no record of what changed.

## Testing mindset

Always ask: **How can this break?** Test empty/large/duplicate data, similar titles, Unicode/CJK, malformed URLs, missing metadata, network/API failure, stale responses, slow loading, iframes, dynamic players, refresh, popup reopen, browser restart, rapid clicks, invalid timestamps, seeking, pause/buffering, multiple tabs/sources, unusual episode numbers, and completion duplication.

## Documentation

Keep documentation factual and synchronized with the actual repository. Never document an intended feature as shipped. If a task is only investigated and not fixed, record it as investigated/not fixed.
