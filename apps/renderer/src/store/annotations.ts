import { create } from "zustand";

import type {
  BrowserAnnotation,
  CodeAnnotation,
  ComposerAnnotation,
  SessionId,
} from "@zuse/contracts";

import { readStorageWithLegacy } from "../lib/storage-keys.ts";

/**
 * Draft code annotations, keyed by chat session. The user selects code in the
 * file editor / diff view and pins a comment; the annotation stacks here and is
 * rendered in a tray above that session's composer. On submit the composer
 * drains this list into the outgoing `ComposerInput` and clears it.
 *
 * Persisted to `localStorage` (manual load/save, matching `merge-prefs.ts`) so
 * un-sent annotations survive a window reload / app restart — they're drafty by
 * nature, so a DB-backed queue would be overkill.
 */
const STORAGE_KEY = "zuse.annotations.v1";
const LEGACY_STORAGE_KEYS = ["memoize.annotations.v1"] as const;

type Persisted = Record<string, ReadonlyArray<ComposerAnnotation>>;

const load = (): Persisted => {
  try {
    const raw = readStorageWithLegacy(
      window.localStorage,
      STORAGE_KEY,
      LEGACY_STORAGE_KEYS,
    );
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Persisted;
  } catch {
    return {};
  }
};

const persist = (state: Persisted): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private-mode / quota errors are non-fatal — the drafts just won't stick.
  }
};

/** Stable id generator; falls back when `crypto.randomUUID` is unavailable. */
const newId = (): string => {
  try {
    return crypto.randomUUID();
  } catch {
    return `ann-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
};

type AnnotationsState = {
  readonly bySession: Persisted;
  /** Append an annotation; `id` is generated here. Returns the new id. */
  readonly add: (
    sessionId: SessionId,
    annotation: Omit<CodeAnnotation, "id">,
  ) => string;
  readonly addBrowser: (
    sessionId: SessionId,
    annotation: Omit<BrowserAnnotation, "id" | "_tag" | "createdAt">,
  ) => BrowserAnnotation;
  readonly remove: (sessionId: SessionId, id: string) => void;
  readonly updateComment: (
    sessionId: SessionId,
    id: string,
    comment: string,
  ) => void;
  readonly clear: (sessionId: SessionId) => void;
};

export const useAnnotationsStore = create<AnnotationsState>((set, get) => ({
  bySession: load(),
  add: (sessionId, annotation) => {
    const id = newId();
    const entry: CodeAnnotation = { ...annotation, id };
    const current = get().bySession[sessionId] ?? [];
    const bySession = { ...get().bySession, [sessionId]: [...current, entry] };
    set({ bySession });
    persist(bySession);
    return id;
  },
  addBrowser: (sessionId, annotation) => {
    const entry: BrowserAnnotation = {
      ...annotation,
      _tag: "browser",
      id: newId(),
      createdAt: new Date().toISOString(),
    };
    const current = get().bySession[sessionId] ?? [];
    const bySession = { ...get().bySession, [sessionId]: [...current, entry] };
    set({ bySession });
    persist(bySession);
    return entry;
  },
  remove: (sessionId, id) => {
    const current = get().bySession[sessionId];
    if (current === undefined) return;
    const next = current.filter((a) => a.id !== id);
    const bySession = { ...get().bySession };
    if (next.length === 0) delete bySession[sessionId];
    else bySession[sessionId] = next;
    set({ bySession });
    persist(bySession);
  },
  updateComment: (sessionId, id, comment) => {
    const current = get().bySession[sessionId];
    if (current === undefined) return;
    const trimmed = comment.trim();
    if (trimmed.length === 0) return;
    const next = current.map((a) =>
      a.id === id ? { ...a, comment: trimmed } : a,
    );
    const bySession = { ...get().bySession, [sessionId]: next };
    set({ bySession });
    persist(bySession);
  },
  clear: (sessionId) => {
    if (get().bySession[sessionId] === undefined) return;
    const bySession = { ...get().bySession };
    delete bySession[sessionId];
    set({ bySession });
    persist(bySession);
  },
}));

/** Snapshot read for non-reactive callers (e.g. the submit handler). */
export const annotationsForSession = (
  sessionId: SessionId,
): ReadonlyArray<ComposerAnnotation> =>
  useAnnotationsStore.getState().bySession[sessionId] ?? [];
