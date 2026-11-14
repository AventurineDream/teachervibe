# TeacherVibe

Red-pen that slop till it's 💯.

A local-first repository viewer and annotator for people who direct coding agents -
built for people just getting their software start with agent coding. You do not
need to be a coder: the repo reads like a document, not an IDE.

## Status

**Shelved** (vault lifecycle). The implemented milestone is the Phase 1 read → annotate → hand off loop, including pinned snapshots, IndexedDB annotations, and deterministic review export. Repository maintenance does not change that lifecycle.

Three pillars:

1. **A code annotation protocol for agents** - structured, machine-consumable
   anchors (commit + path + range + text hash), not screenshots of code.
2. **A seamless, pretty annotation process for humans** - click or drag lines,
   type a note, done.
3. **One-button export** - the review tray's *copy prompt* button compresses
   your annotations into a ready-to-paste prompt for your coding agent.

It treats a repository as a legible document: you read, navigate, and pin precise
annotations to exact commits, then export a review packet an agent can act on
without guessing what code or revision you meant. It is not an IDE: no editing,
no terminal, no task runner, no autonomous changes.

Phase 1 scope: one complete read -> annotate -> hand off loop.

- Static Vite + TypeScript app, native custom elements, no framework.
- Prism tokenization on a read-only document - selection is for quoting, never replacement.
- Source adapters: public GitHub (REST), Forgejo (REST, Gitea-compatible `/api/v1`),
  local folders (File System Access API). One snapshot contract for all three.
- Every session pins to an exact commit SHA; branch names are labels only.
- Annotations are typed (`note` / `question` / `request` / `decision` / `concern`),
  anchored by commit + path + range + text hash + context windows, and persist in
  IndexedDB. Versioned JSON import/export for backups.
- Review tray exports a deterministic review packet as Markdown + JSON, and a
  one-button *copy prompt* that compresses the tray into a paste-ready agent prompt.
- Anchors that cannot be re-resolved against the viewed commit say so (`moved`) -
  the viewer never silently reattaches a note to nearby code.

## Quick start

Use Node.js 22+ and npm.

```sh
git clone https://github.com/AventurineDream/teachervibe.git
cd teachervibe
npm ci
bash tools/install_hooks.sh
npm run dev        # open the local URL printed by Vite
```

```sh
npm run build      # production build -> dist/ (one command)
npm run preview    # serve the built app locally
```

## Commands

| Task | Command |
| --- | --- |
| Development | `npm run dev` |
| Build | `npm run build` |
| Format | `npm run format` (check: `npm run format:check`) |
| Lint | Not configured |
| Typecheck | `npx tsc --noEmit` (also part of build) |
| Test (fast) | `npm run test:unit` |
| Test (browser) | `npm run test:browser` |
| Full gate | `npm run format:check && npm run build && npm run test:unit && npm run test:browser` |
| Install staged-comment gate | `bash tools/install_hooks.sh` |

Install Chromium once with `npx playwright install chromium` (Linux CI uses `--with-deps`). CI (`.github/workflows/test.yml`) retains unit/browser tests and also runs the existing production build/typecheck plus the [incremental comment gate](docs/decisions/0001-incremental-standard-adoption.md).

## Static hosting (lilbox)

The build is fully static with a relative base, so it works from any path:

```sh
npm run build
# serve dist/ with anything, e.g.:
python3 -m http.server 4174 --directory dist
```

No backend, no service worker, no environment config. Unauthenticated GitHub API
access is rate-limited to 60 requests/hour per IP; the app surfaces that as a
distinct state when it happens.

## Mirror workflow

GitHub is the canonical public mirror. A self-hosted Forgejo instance can be the working origin; configure its URL locally rather than recording private network details in the repository. Repository creation on Forgejo remains a manual administrator step. Review work stays on feature branches and is submitted as PRs; do not mirror an unreviewed branch onto `main`.

## Reading, annotating, handing off

1. Open `owner/repo`, a GitHub URL, a Forgejo URL, or a local folder. The session
   pins to the default branch's current commit (or a `/tree/<ref>` you pasted).
2. Navigate: Files / Outline / Trail in the left rail, `j`/`k` line movement,
   `/` to search the open file, deep links in the URL for everything.
3. Select lines (click gutter, shift-click or drag to extend), press `a`, write
   the note. It persists in this browser.
4. Add notes to the review tray, order them, export Markdown + JSON - paste the
   Markdown straight into an agent conversation.

## Contracts

The versioned schemas and their invariants (commit pinning, failed re-anchoring,
deterministic export) live in `src/contracts/` and are documented in
[docs/contracts.md](docs/contracts.md).

## Layout

- `src/contracts/`: annotation schema, hashing/re-anchoring, deterministic serialization.
- `src/sources/`: GitHub, Forgejo, and local-folder snapshot adapters.
- `src/store/`: session actions, in-memory state, and browser-local IndexedDB persistence.
- `src/ui/`: read-only custom elements, navigation, annotation inspector, and review tray.
- `tests/`: Vitest unit tests and Playwright browser flows.
- `docs/`: architecture, contract invariants, and adoption decision.
- `tools/`: committed lightweight development hooks.
- `.github/`: the existing CI workflow.
- `index.html`, `src/main.ts`, and `vite.config.ts`: static app bootstrap/build.

## Documentation

Start at the [documentation index](docs/README.md) and [architecture](docs/architecture.md); existing [contracts](docs/contracts.md) define revision pinning, anchoring, storage, and export invariants.

Project planning lives in Aven's vault: [TeacherVibe](obsidian://open?vault=Home&file=10_Projects%2FShelved%2FTeacherVibe%2FTeacherVibe.md) (`10_Projects/Shelved/TeacherVibe/TeacherVibe.md`).

## License

MIT - see [LICENSE](LICENSE).
