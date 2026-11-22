# Changelog

Changes are recorded using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No historical releases are invented here.

## [Unreleased]

### Added

- Human/agent setup and command guidance, a documentation index, and an incremental standard-adoption decision.
- A lightweight staged-source reminder ownership hook, safe per-clone installer, and the same gate in the existing CI workflow.
- Architecture overview linking the existing revision, anchoring, storage, and export contracts.
- ESLint flat config (`eslint.config.js`, recommended rules) with `npm run lint`, run in CI after the format check.
- Unit tests for the local-folder adapter and for App actions (notes, tray, packet, backup import/export, route opening).

### Changed

- Adopted formatter check and ESLint run in the documented handoff and CI gates; stricter type-aware lint rules remain deferred.
- Existing CI also runs the production build/typecheck without replacing the unit/browser test jobs.
