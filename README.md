# TeacherVibe

Red-pen that slop till it's 💯.

A local-first repository viewer and annotator for people who direct coding agents -
built for people just getting their software start with agent coding. You do not
need to be a coder: the repo reads like a document, not an IDE.

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

## Run it

```sh
npm install
npm run dev        # development server (one command)
```

```sh
npm run build      # production build -> dist/ (one command)
npm run preview    # serve the built app locally
```

## Test

```sh
npm run test:unit       # Vitest: contracts, anchors, serialization, adapters
npx playwright install chromium   # once
npm run test:browser    # Playwright: real-browser reading, annotation, export flows
```

CI (`.github/workflows/test.yml`) runs both on every push to `main` and every PR.

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

## Forgejo <-> GitHub mirror workflow

The self-hosted Forgejo instance (LAN-only, e.g. `http://10.0.0.108:3000`) is the
working origin; GitHub is the canonical public mirror:

```sh
git clone <forgejo-ssh-url> teachervibe
cd teachervibe
git remote add github git@github.com:AventurineDream/teachervibe.git
# day to day: push to origin (Forgejo)
git push origin main
# publish: mirror to GitHub
git push github main
```

Forgejo repo creation stays a manual step on the instance (its web UI is LAN-only);
GitHub pushes authenticate with the repo-scoped deploy key, not an account key.

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

## License

MIT - see [LICENSE](LICENSE).
