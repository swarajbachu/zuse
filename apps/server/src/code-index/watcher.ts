import { Effect } from "effect";
import { watch } from "node:fs";
import { join } from "node:path";

const IGNORE = new Set([
  ".git",
  "node_modules",
  ".zuse",
  "dist",
  "build",
  ".turbo",
  ".next",
  ".cache",
  "coverage",
  "out",
]);

const DEBOUNCE_MS = 120;

export interface FileChange {
  readonly absPath: string;
  readonly kind: "modify" | "remove";
}

export type ChangeListener = (changes: ReadonlyArray<FileChange>) => void;

/**
 * Minimal recursive file watcher built on `fs.watch({ recursive: true })`.
 * macOS + Windows support recursive natively; Linux fans out per-dir
 * inside libuv. We avoid `@parcel/watcher` for the same reason we ship
 * the dual-runtime sqlite shim — it's an extra native rebuild and the
 * incremental cost (a few extra inotify watches) is negligible at the
 * sizes a single repo will hit.
 *
 * Changes are batched on a 120ms debounce so a save-on-build that
 * touches 30 files turns into one drain instead of 30.
 */
export const startWatcher = (
  root: string,
  onChange: ChangeListener,
): Effect.Effect<{ stop: () => void }> =>
  Effect.sync(() => {
    const pending = new Map<string, FileChange>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (pending.size === 0) return;
      const batch = Array.from(pending.values());
      pending.clear();
      try {
        onChange(batch);
      } catch (cause) {
        // Watcher must never throw out — log and keep running.
        // eslint-disable-next-line no-console
        console.error("[code-index.watcher] onChange failed:", cause);
      }
    };

    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
    };

    const shouldIgnore = (rel: string): boolean => {
      const first = rel.split("/")[0] ?? rel.split("\\")[0] ?? "";
      return IGNORE.has(first);
    };

    let handle: ReturnType<typeof watch> | null = null;
    try {
      handle = watch(
        root,
        { recursive: true },
        (event, filename) => {
          if (filename === null) return;
          const rel = filename.toString();
          if (shouldIgnore(rel)) return;
          const abs = join(root, rel);
          // We can't tell "removed" vs "renamed" from fs.watch — treat
          // every event as "modify" and let `reindexFile` discover the
          // file is gone (its EIO bubbles as IndexIoError which the
          // caller swallows).
          pending.set(abs, {
            absPath: abs,
            kind: event === "rename" ? "remove" : "modify",
          });
          schedule();
        },
      );
      handle.on("error", (err) => {
        // eslint-disable-next-line no-console
        console.warn("[code-index.watcher] fs.watch error:", err.message);
      });
    } catch (err) {
      // Some FUSE-mounted or network paths reject watch — degrade
      // silently to "no watching" rather than crashing the host.
      // eslint-disable-next-line no-console
      console.warn(
        `[code-index.watcher] could not watch ${root}: ${(err as Error).message}`,
      );
    }

    return {
      stop: () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        handle?.close();
      },
    };
  });
