# Changelog

Changes are recorded using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No historical releases are invented here.

## [Unreleased]

### Added

- Human/agent setup and command guidance, a documentation index, and an incremental standard-adoption decision.
- A lightweight staged-source reminder ownership hook, safe per-clone installer, and the same gate in the existing CI workflow.
- Architecture overview linking the existing revision, anchoring, storage, and export contracts.

### Changed

- Adopted formatter check is part of the documented handoff and CI gates; legacy semantic lint requirements remain explicitly deferred.
- Existing CI also runs the production build/typecheck without replacing the unit/browser test jobs.
