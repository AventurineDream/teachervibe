/**
 * App state: one store, coarse subscribe/notify, actions as plain async functions.
 * Components render from a snapshot of this state and re-render on notify.
 */

import type {
  Annotation,
  FileRecord,
  ReadingTrailEntry,
  RepositorySnapshot
} from '../contracts/schema.js';

export type AppPhase = 'idle' | 'opening' | 'ready' | 'error';

export interface FileView {
  record: FileRecord;
  state: 'loading' | 'text' | 'binary' | 'unsupported' | 'error';
  text?: string;
  reason?: string;
}

export interface AppState {
  phase: AppPhase;
  error: { kind: string; message: string } | null;
  snapshot: RepositorySnapshot | null;
  file: FileView | null;
  /** Selected 1-based line range in the open file, inclusive. */
  selection: { start: number; end: number } | null;
  annotations: Annotation[];
  /** Annotation ids in review-tray order. */
  tray: string[];
  trail: ReadingTrailEntry[];
  typeFilter: Set<string>;
  statusFilter: Set<string>;
  searchQuery: string;
  drawer: 'nav' | 'tray' | null;
  /** Annotation currently open in the inspector (id), or 'draft' for a new one. */
  inspectorTarget: string | null;
  statusMessage: string | null;
}

export const initialState: AppState = {
  phase: 'idle',
  error: null,
  snapshot: null,
  file: null,
  selection: null,
  annotations: [],
  tray: [],
  trail: [],
  typeFilter: new Set(),
  statusFilter: new Set(),
  searchQuery: '',
  drawer: null,
  inspectorTarget: null,
  statusMessage: null
};

export type Listener = (state: AppState) => void;

export class Store {
  private state: AppState;
  private listeners = new Set<Listener>();

  constructor(initial: AppState = initialState) {
    this.state = initial;
  }

  get(): AppState {
    return this.state;
  }

  /** Replace the state wholesale and notify. Actions mutate a draft then commit. */
  commit(next: AppState): void {
    this.state = next;
    for (const l of this.listeners) l(this.state);
  }

  /** Shallow-merge patch helper. */
  patch(partial: Partial<AppState>): void {
    this.commit({ ...this.state, ...partial });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function pushTrail(state: AppState, entry: ReadingTrailEntry): ReadingTrailEntry[] {
  const last = state.trail[state.trail.length - 1];
  if (last && last.path === entry.path && last.commit === entry.commit &&
      last.range?.start === entry.range?.start && last.range?.end === entry.range?.end) {
    return state.trail;
  }
  return [...state.trail.slice(-99), entry];
}
