import type { ProviderId } from "@zuse/wire";

export interface ModelPickerEvent {
  providerId: ProviderId;
  modelId: string;
  at: number;
}

export interface ModelPickerRecent {
  providerId: ProviderId;
  modelId: string;
  count: number;
  lastAt: number;
}

const STORAGE_KEY = "zuse.modelpicker.events.v2";
const LEGACY_EVENTS_KEY = "memoize.modelpicker.events.v2";
const LEGACY_KEY = "memoize.modelpicker.recents.v1";
const MAX_EVENTS = 500;
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readRaw(storage: Storage): ModelPickerEvent[] {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) {
    const legacyEvents = storage.getItem(LEGACY_EVENTS_KEY);
    if (legacyEvents !== null) {
      try {
        storage.setItem(STORAGE_KEY, legacyEvents);
        storage.removeItem(LEGACY_EVENTS_KEY);
      } catch {
        // ignore write failures
      }
      return parseEvents(legacyEvents);
    }
    return migrateLegacy(storage);
  }
  return parseEvents(raw);
}

function parseEvents(raw: string): ModelPickerEvent[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: ModelPickerEvent[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as {
        providerId?: unknown;
        modelId?: unknown;
        at?: unknown;
      };
      if (typeof e.providerId !== "string") continue;
      if (typeof e.modelId !== "string") continue;
      if (typeof e.at !== "number") continue;
      out.push({
        providerId: e.providerId as ProviderId,
        modelId: e.modelId,
        at: e.at,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// One-time migration: collapse the legacy MRU list into synthetic events so a
// returning user doesn't lose their recents on upgrade.
function migrateLegacy(storage: Storage): ModelPickerEvent[] {
  const raw = storage.getItem(LEGACY_KEY);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    const out: ModelPickerEvent[] = [];
    parsed.forEach((entry, i) => {
      if (typeof entry !== "object" || entry === null) return;
      const e = entry as { providerId?: unknown; modelId?: unknown };
      if (typeof e.providerId !== "string") return;
      if (typeof e.modelId !== "string") return;
      out.push({
        providerId: e.providerId as ProviderId,
        modelId: e.modelId,
        at: now - i * 60_000,
      });
    });
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(out));
      storage.removeItem(LEGACY_KEY);
    } catch {
      // ignore write failures
    }
    return out;
  } catch {
    return [];
  }
}

export function readModelPickerEvents(): ModelPickerEvent[] {
  const storage = safeStorage();
  if (storage === null) return [];
  return readRaw(storage);
}

export function pushModelPickerEvent(entry: {
  providerId: ProviderId;
  modelId: string;
}): void {
  const storage = safeStorage();
  if (storage === null) return;
  const current = readRaw(storage);
  const next = [
    { providerId: entry.providerId, modelId: entry.modelId, at: Date.now() },
    ...current,
  ].slice(0, MAX_EVENTS);
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore write failures (quota, private mode)
  }
}

export function topRecents(
  events: ReadonlyArray<ModelPickerEvent>,
  scope: ProviderId | "all",
  limit: number,
): ModelPickerRecent[] {
  const cutoff = Date.now() - WINDOW_MS;
  const buckets = new Map<string, ModelPickerRecent>();
  for (const e of events) {
    if (e.at < cutoff) continue;
    if (scope !== "all" && e.providerId !== scope) continue;
    const key = `${e.providerId}::${e.modelId}`;
    const cur = buckets.get(key);
    if (cur === undefined) {
      buckets.set(key, {
        providerId: e.providerId,
        modelId: e.modelId,
        count: 1,
        lastAt: e.at,
      });
    } else {
      cur.count += 1;
      if (e.at > cur.lastAt) cur.lastAt = e.at;
    }
  }
  return Array.from(buckets.values())
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, limit);
}
