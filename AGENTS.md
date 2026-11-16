# teachervibe — Agent Guide

<!-- Owner: Aven. Maintained by: Malachite. Last verified: 2026-11-09 (commands read from package.json/CI, not re-run). -->

## Purpose and sources of truth
Local-first repository viewer/annotator for people directing coding agents. Static Vite + TypeScript, native custom elements. Specs: `docs/`; behavior of record: `README.md`.
Vault note: `10_Projects/Shelved/TeacherVibe/TeacherVibe.md` (Aven's vault).

## Setup
```bash
npm ci   # Node 22+
bash tools/install_hooks.sh
```

## Commands
| Task | Command |
|---|---|
| Format | `npm run format` (check: `npm run format:check`) |
| Lint | none |
| Typecheck | `npx tsc --noEmit` (also run by `npm run build`) |
| Test (fast) | `npm run test:unit` |
| Test (full / slow) | `npx playwright install chromium` once, then `npm run test:browser` |
| Full gate (run before handoff) | `npm run format:check && npm run build && npm run test:unit && npm run test:browser` |
| Install staged-comment gate | `bash tools/install_hooks.sh` |

## Definition of done
1. Full gate passes (paste the command + result in the handoff).
2. New or changed behavior has a test.
3. Comments meet the Aven Code Standard (vault `99_System/Standards/Code Standard.md`) for every touched file; stale comments are P2 through 2027-02-09, then P1.
4. User-visible changes are noted in CHANGELOG.md under Unreleased.
5. Small, focused diff on a feature branch; never commit to `main` unless told to. Formatting-only changes go in their own commit.

## Boundaries
Annotations must stay pinned to an exact commit SHA and never silently reattach to nearby code (anchors that cannot resolve report `moved`). Keep the app static: no backend, no service worker. Do not add LAN addresses or credentials to docs.
License: MIT (see LICENSE); preserve this existing choice.

## Repository map
src/ app code (adapters, anchors, serialization, UI elements); tests/ unit + Playwright; docs/ design docs; index.html, vite.config.ts, playwright.config.ts.

## Handoff
Summarize files changed, behavior added, commands run with results, and anything unverified.
