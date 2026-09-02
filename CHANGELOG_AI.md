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
```
