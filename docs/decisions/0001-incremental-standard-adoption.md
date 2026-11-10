# 0001: Adopt code standards incrementally

Date: 2026-11-09. Status: adopted on the review branch; subject to PR review, not a merge authorization.

## Context

The Aven Code Standard calls for usable setup, human/agent entry points, a documentation map, changelog, and changed-source comment ratcheting. These repositories already have working project-specific checks; copying a blanket lint template would add unconfigured tools or apply new rules to untouched legacy code.

## Decision

Reuse the canonical standard's committed hook/install pattern and added-line R5 ownership rule. `bash tools/install_hooks.sh` configures this clone's `core.hooksPath`; it refuses to replace an existing custom path or clone-local pre-commit hook. Git runs `tools/hooks/pre-commit` over staged source additions only. CI invokes the same script with `--base <revision>`, using the PR base or previous main commit and full checkout history. Invalid revisions fail rather than silently skipping checks. The script requires only Bash, Git, and grep, and never runs a formatter or fetches a dependency.

Keep the existing Vitest and Playwright checks, and run the existing production build (including TypeScript checking) in the same workflow. Preserve the static, read-only application. No ESLint gate or stricter TypeScript flags are introduced.

## Consequences and deferred requirements

- Headers (R1), public API documentation (R2), and comment correctness remain review obligations; this lightweight hook does **not** claim to enforce them automatically. Changed-file semantic enforcement needs language-aware tooling before it can become a reliable CI gate.
- The owner rule recognizes the standard's lowercase named-owner syntax; it does not validate an owner roster or whether a reminder is linked to a task.
- Full-file 400-character limits and blanket ESLint/JSDoc rules from the generic template are not enabled on legacy code. Numeric comment-density targets are not gates.
- The already-adopted `npm run format:check` runs in the documented full gate and existing CI, respecting the committed `.prettierignore`. This metadata change neither widens that scope nor reformats legacy files.
- Preserve existing licenses. Where no license has been chosen, the default is all rights reserved; adoption is not permission to relicense.
- Existing design and operational documents stay in place and are indexed, rather than creating empty plans/runbook folders or duplicating content.
