# AniTrack — Working Instructions

## Rule 1: One feature at a time
- Pick exactly ONE feature per session/day.
- Take it to its best, most accurate version before touching anything else.
- Do not start a second feature until the first is done, tested, and logged.
- If a bug blocks the feature, fixing it counts as part of that feature — don't call it a new one.

## Rule 2: The project must always self-document
Every session, before ending, update `PROGRESS.md` with:
- What feature was worked on
- What changed (files touched)
- Current state: done / in-progress / blocked
- What's next

This means anyone (or any future session) can open `PROGRESS.md` and know exactly
where the project stands — no re-explaining from scratch.

## Rule 3: README.md stays accurate
`README.md` describes what the extension currently does and how it's structured —
not what it's supposed to do eventually. Update it whenever a feature actually
ships, not before.

## Rule 4: Version numbers are real
`manifest.json` version and any in-code version comments must match. Bump on
every shipped feature. Never let them drift (they drifted before: manifest said
9.0.0, content.js said v11).

## Session checklist
1. Read `PROGRESS.md` first — know where things left off.
2. Pick today's ONE feature.
3. Build it, test it, refine it until it's solid.
4. Update `PROGRESS.md` and `README.md` if the feature shipped.
5. Bump version if shipped.
6. Commit.
