# TeacherVibe architecture

## Delivery and components

TeacherVibe is a static Vite/TypeScript app with native custom elements and Prism tokenization. `src/main.ts` bootstraps the UI; the production build is served from `dist/`. There is no backend, service worker, terminal, repository editor, or autonomous agent runner.

- `src/sources/` classifies inputs and loads GitHub, Forgejo, or local-folder snapshots through a shared adapter contract. Remote adapters use REST; local access uses the browser File System Access API.
- `src/contracts/` owns versioned schemas, anchor hashing/resolution, and deterministic review serialization.
- `src/store/actions.ts` coordinates loading, selection, annotations, review tray, and import/export. `state.ts` holds session state; `db.ts` persists browser-local annotations and key/value state in IndexedDB.
- `src/ui/` renders navigation, read-only code documents, annotation inspection, and the review tray. Router state supports navigation/deep links.

## Data flow

Repository input → source adapter → snapshot/session → read-only document → selected quote and anchor → annotation → IndexedDB and review tray → Markdown/JSON review packet or copied prompt. The exported packet is the handoff boundary: any later code changes happen outside this app.

## Invariants and trust boundaries

The existing [contracts](contracts.md) are authoritative:

- Git sessions pin to exact commit SHAs; branch names are labels. Local folders have no durable commit and their anchors are best-effort.
- Anchors carry source identity, range, text hash, and context. Resolution reports exact, uniquely relocated, or moved; ambiguous/missing text never silently reattaches.
- Annotation/export schemas are versioned. Review packets preserve human tray order and use deterministic serialization without wall-clock fields.
- IndexedDB storage is browser-local; clearing browser data removes it unless the user exported a backup. Reading-trail state is session-scoped.
- Remote browsing sends requests to the selected GitHub/Forgejo service. Annotation handoff is an explicit export, not an automatic submission to an agent.
- GitHub rate limits and local folder permissions can prevent loading; the UI must surface those failures rather than inventing a snapshot.

## Checks and operations

Vitest covers contracts, anchors, serialization, and adapters; Playwright covers real-browser reading/annotation/export flows. The existing CI workflow also builds/typechecks the app and checks adopted formatting and added-comment ownership. Static deployment and browser setup remain in the [README](../README.md), avoiding duplicate runbooks.
