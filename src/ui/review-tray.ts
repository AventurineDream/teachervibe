/**
 * <reader-tray> - the handoff set. Order notes, attach a target ref, preview the
 * packet, export deterministic Markdown + JSON. The packet is the product's
 * reason to exist: precise context an agent can act on without guessing.
 */

import type { App } from '../store/actions.js';
import type { AppState } from '../store/state.js';
import { escapeHtml, renderUnlessFocused, download, copyText } from './dom.js';

export class ReaderTray extends HTMLElement {
  private app: App | null = null;
  private unsubscribe: (() => void) | null = null;
  private showPreview = false;

  connect(app: App): void {
    this.app = app;
    this.unsubscribe?.();
    this.unsubscribe = app.store.subscribe((s) => this.render(s));
    this.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tray]');
      if (!el || !this.app) return;
      const action = el.dataset['tray']!;
      const id = el.dataset['id'];
      if (action === 'up') this.app.trayMove(id!, -1);
      else if (action === 'down') this.app.trayMove(id!, 1);
      else if (action === 'remove') this.app.trayRemove(id!);
      else if (action === 'open') this.app.openAnnotation(id!);
      else if (action === 'preview') {
        this.showPreview = !this.showPreview;
        this.render(this.app.store.get());
      } else if (action === 'copy-prompt') {
        const packet = this.app?.packet(this.targetRef());
        if (packet)
          void copyText(packet.prompt).then((ok) =>
            this.app?.setStatus(ok ? 'Prompt copied - paste it straight into your coding agent.' : 'Copy failed.')
          );
      } else if (action === 'export-md') {
        const packet = this.app.packet(this.targetRef());
        if (packet) download('review-packet.md', packet.markdown, 'text/markdown');
      } else if (action === 'export-json') {
        const packet = this.app.packet(this.targetRef());
        if (packet) download('review-packet.json', packet.json, 'application/json');
      } else if (action === 'copy-md') {
        const packet = this.app.packet(this.targetRef());
        if (packet) void copyText(packet.markdown).then((ok) => this.app?.setStatus(ok ? 'Packet Markdown copied - paste it into an agent conversation.' : 'Copy failed.'));
      }
    });
  }

  private targetRef(): string {
    return this.querySelector<HTMLInputElement>('[data-target-ref]')?.value.trim() ?? '';
  }

  private render(state: AppState): void {
    const items = state.tray
      .map((id, i) => {
        const a = state.annotations.find((x) => x.id === id);
        if (!a) return '';
        return `<li class="tray-item" data-id="${a.id}">
          <span class="tray-order">${i + 1}</span>
          <button class="tray-open" data-tray="open" data-id="${a.id}">
            <span class="type-tag type-${a.type}">${a.type}</span>
            ${escapeHtml(a.anchor.path)} L${a.anchor.start.line}-L${a.anchor.end.line}
          </button>
          <span class="tray-ops">
            <button data-tray="up" data-id="${a.id}" title="Move up">&#8593;</button>
            <button data-tray="down" data-id="${a.id}" title="Move down">&#8595;</button>
            <button data-tray="remove" data-id="${a.id}" title="Remove">&#10005;</button>
          </span>
        </li>`;
      })
      .join('');

    const packet = state.tray.length && state.snapshot ? this.app!.packet(this.targetRef()) : null;
    const preview = this.showPreview && packet ? `<pre class="packet-preview">${escapeHtml(packet.markdown)}</pre>` : '';

    renderUnlessFocused(
      this,
      `<div class="tray-head"><strong>Review tray</strong> <span class="count">${state.tray.length}</span></div>
       ${
         state.tray.length
           ? `<ol class="tray-list">${items}</ol>
              <label class="target-ref">Target branch or commit <input type="text" data-target-ref placeholder="(optional)" spellcheck="false"></label>
              <div class="tray-actions">
                <button class="primary" data-tray="copy-prompt" title="Compress the tray into a ready-to-paste agent prompt">&#9889; copy prompt</button>
                <button data-tray="preview">${this.showPreview ? 'hide preview' : 'preview packet'}</button>
                <button data-tray="copy-md">copy Markdown</button>
                <button data-tray="export-md">download .md</button>
                <button data-tray="export-json">download .json</button>
              </div>
              ${preview}`
           : `<div class="tray-empty">Add annotations from the inspector to build a handoff packet.</div>`
       }`
    );
  }
}

export function defineTray(): void {
  customElements.define('reader-tray', ReaderTray);
}
