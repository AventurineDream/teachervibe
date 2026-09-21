/**
 * <reader-app> - shell: header with the repository switcher, three regions
 * (nav rail, document pane, inspector), review tray, status and error surfaces.
 * Regions are separate custom elements; the shell owns layout and header actions.
 */

import type { App } from '../store/actions.js';
import type { AppState } from '../store/state.js';
import { escapeHtml, renderUnlessFocused, download, shortSha } from './dom.js';

export class ReaderApp extends HTMLElement {
  private app: App | null = null;
  private unsubscribe: (() => void) | null = null;

  connect(app: App): void {
    this.app = app;
    this.unsubscribe?.();
    this.unsubscribe = app.store.subscribe((state) => this.render(state));
    this.innerHTML = `
      <header class="topbar">
        <button class="drawer-btn" data-action="drawer-nav" aria-label="Open navigation">&#9776;</button>
        <span class="brand">TeacherVibe</span>
        <form class="switcher" data-role="switcher">
          <input type="text" name="repo" placeholder="owner/repo, GitHub URL, or Forgejo URL" aria-label="Repository" autocomplete="off" spellcheck="false">
          <button type="submit">Open</button>
        </form>
        <button data-action="open-local" data-role="local-btn">Open folder</button>
        <span class="commit-chip" data-role="commit" title="Pinned commit"></span>
        <button class="drawer-btn" data-action="drawer-tray" aria-label="Open review tray">&#128203;</button>
      </header>
      <div class="error-banner" data-role="error" hidden></div>
      <main class="regions">
        <reader-nav class="rail" data-role="nav"></reader-nav>
        <reader-pane class="pane" data-role="pane"></reader-pane>
        <reader-inspector class="inspector" data-role="inspector"></reader-inspector>
      </main>
      <reader-tray data-role="tray"></reader-tray>
      <div class="status-line" data-role="status" aria-live="polite"></div>
    `;
    this.querySelector<HTMLFormElement>('[data-role="switcher"]')!.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = this.querySelector<HTMLInputElement>('input[name="repo"]')!;
      void this.app?.openFromInput(input.value);
    });
    this.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset['action'];
      if (!action || !this.app) return;
      if (action === 'open-local') void this.app.openLocal();
      if (action === 'drawer-nav') this.app.setDrawer(this.app.store.get().drawer === 'nav' ? null : 'nav');
      if (action === 'drawer-tray') this.app.setDrawer(this.app.store.get().drawer === 'tray' ? null : 'tray');
      if (action === 'export-backup') void this.exportBackup();
      if (action === 'import-backup') this.pickImportFile();
    });
    for (const [role, tag] of [['nav', 'reader-nav'], ['pane', 'reader-pane'], ['inspector', 'reader-inspector'], ['tray', 'reader-tray']] as const) {
      const el = this.querySelector(`[data-role="${role}"]`);
      (el as unknown as { connect(a: App): void }).connect(app);
      void tag;
    }
    this.render(app.store.get());
  }

  private async exportBackup(): Promise<void> {
    if (!this.app) return;
    download('teachervibe-annotations.json', await this.app.exportBackup(), 'application/json');
    this.app.setStatus('Exported annotation backup.');
  }

  private pickImportFile(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file || !this.app) return;
      try {
        await this.app.importBackup(await file.text());
      } catch (err) {
        this.app.setStatus(`Import failed: ${(err as Error).message}`);
      }
    });
    input.click();
  }

  private render(state: AppState): void {
    const commit = this.querySelector<HTMLElement>('[data-role="commit"]')!;
    if (state.snapshot) {
      commit.textContent = `@${shortSha(state.snapshot.commit)}${state.snapshot.defaultBranch ? ` (${state.snapshot.defaultBranch})` : ''}`;
      commit.hidden = false;
    } else {
      commit.hidden = true;
    }
    const localBtn = this.querySelector<HTMLButtonElement>('[data-role="local-btn"]')!;
    localBtn.disabled = !this.app?.localFoldersSupported();
    localBtn.title = localBtn.disabled ? 'This browser cannot open local folders (File System Access API missing)' : 'Open a local folder';

    const error = this.querySelector<HTMLElement>('[data-role="error"]')!;
    if (state.error) {
      error.hidden = false;
      renderUnlessFocused(
        error as HTMLElement,
        `<strong>${escapeHtml(state.error.kind)}</strong> - ${escapeHtml(state.error.message)}
         <span class="error-hint">${errorHint(state.error.kind)}</span>`
      );
    } else {
      error.hidden = true;
    }

    const status = this.querySelector<HTMLElement>('[data-role="status"]')!;
    status.textContent = state.statusMessage ?? (state.phase === 'opening' ? 'Opening repository...' : '');
    this.classList.toggle('drawer-nav', state.drawer === 'nav');
    this.classList.toggle('drawer-tray', state.drawer === 'tray');
    this.classList.toggle('inspector-open', state.inspectorTarget !== null);
  }
}

function errorHint(kind: string): string {
  switch (kind) {
    case 'not-found':
      return 'Check the owner/repo spelling. Private repositories are out of Phase 1 scope.';
    case 'rate-limited':
      return 'Unauthenticated GitHub access allows 60 requests/hour per IP. Wait for the reset, then reopen.';
    case 'inaccessible':
      return 'The host refused access. For Forgejo, make sure this browser can reach the instance.';
    case 'unsupported':
      return 'That input is not a supported repository reference.';
    default:
      return 'Network or host problem. Reopening retries from scratch.';
  }
}

export function defineApp(): void {
  customElements.define('reader-app', ReaderApp);
}
