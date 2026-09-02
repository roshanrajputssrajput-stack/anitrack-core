# AniTrack AI Agent Instructions

Read `AI_CONTEXT.md`, `PROGRESS.md`, and `WORKFLOW.md` before changing the project.

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

## Testing mindset

Always ask: **How can this break?** Test empty/large/duplicate data, similar titles, Unicode/CJK, malformed URLs, missing metadata, network/API failure, stale responses, slow loading, iframes, dynamic players, refresh, popup reopen, browser restart, rapid clicks, invalid timestamps, seeking, pause/buffering, multiple tabs/sources, unusual episode numbers, and completion duplication.

## Documentation

Update `PROGRESS.md` after meaningful development work. Keep `README.md` factual about shipped behavior. Keep `AI_CONTEXT.md` current when project-wide context or known issues change.
