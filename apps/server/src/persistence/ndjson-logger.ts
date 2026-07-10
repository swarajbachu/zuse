import { Context, Effect, Layer } from "effect";
import { createWriteStream, mkdirSync, renameSync, type WriteStream } from "node:fs";
import { dirname, join } from "node:path";

import type { FolderId, Message, SessionId } from "@zuse/wire";

import { AppPaths } from "../app-paths.ts";

const ROTATE_BYTES = 100 * 1024 * 1024; // 100 MB per spec

interface SinkEntry {
  readonly path: string;
  readonly stream: WriteStream;
  bytes: number;
}

/**
 * Best-effort per-session NDJSON audit sink. SQLite is canonical; this
 * exists so users can `cat`, share, or post-process transcripts without
 * touching the database. Failures here never propagate — a broken disk
 * or permission issue must not stall the agent loop.
 *
 * Layout: `<userData>/sessions/<projectId>/<sessionId>.events.ndjson`.
 * Rotation: when an active file crosses `ROTATE_BYTES`, it is renamed to
 * `<sessionId>.events.<timestamp>.ndjson` and a fresh active file opens.
 */
export interface NdjsonLoggerShape {
  readonly append: (
    sessionId: SessionId,
    projectId: FolderId,
    message: Message,
  ) => Effect.Effect<void>;
  readonly close: (sessionId: SessionId) => Effect.Effect<void>;
}

export class NdjsonLogger extends Context.Service<
  NdjsonLogger,
  NdjsonLoggerShape
>()("memoize/NdjsonLogger") {}

const ensureDir = (filePath: string): void => {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch {
    // best-effort
  }
};

export const NdjsonLoggerLive = Layer.effect(
  NdjsonLogger,
  Effect.gen(function* () {
    const paths = yield* AppPaths;
    // In-process per-session sink table. Effect.Ref offers no real benefit
    // here — these handles are read-write from the same fiber that consumes
    // the message stream — and would force unnecessary `runSync` ceremony.
    const sinks = new Map<SessionId, SinkEntry>();

    const filePathFor = (
      sessionId: SessionId,
      projectId: FolderId,
    ): string =>
      join(paths.userData, "sessions", projectId, `${sessionId}.events.ndjson`);

    const openSink = (
      sessionId: SessionId,
      projectId: FolderId,
    ): SinkEntry | null => {
      const path = filePathFor(sessionId, projectId);
      try {
        ensureDir(path);
        const stream = createWriteStream(path, { flags: "a" });
        return { path, stream, bytes: 0 };
      } catch {
        return null;
      }
    };

    const rotate = (entry: SinkEntry): SinkEntry | null => {
      try {
        entry.stream.end();
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const rotated = entry.path.replace(
          /\.events\.ndjson$/,
          `.events.${stamp}.ndjson`,
        );
        renameSync(entry.path, rotated);
        const stream = createWriteStream(entry.path, { flags: "a" });
        return { path: entry.path, stream, bytes: 0 };
      } catch {
        return null;
      }
    };

    const append: NdjsonLoggerShape["append"] = (
      sessionId,
      projectId,
      message,
    ) =>
      Effect.sync(() => {
        let entry = sinks.get(sessionId);
        if (entry === undefined) {
          const fresh = openSink(sessionId, projectId);
          if (fresh === null) return;
          sinks.set(sessionId, fresh);
          entry = fresh;
        }
        try {
          const line = `${JSON.stringify(message)}\n`;
          const buf = Buffer.from(line, "utf-8");
          entry.stream.write(buf);
          entry.bytes += buf.byteLength;
          if (entry.bytes >= ROTATE_BYTES) {
            const rotated = rotate(entry);
            if (rotated !== null) sinks.set(sessionId, rotated);
          }
        } catch {
          // swallow — best-effort sink
        }
      });

    const close: NdjsonLoggerShape["close"] = (sessionId) =>
      Effect.sync(() => {
        const entry = sinks.get(sessionId);
        if (entry === undefined) return;
        try {
          entry.stream.end();
        } catch {
          /* ignore */
        }
        sinks.delete(sessionId);
      });

    return { append, close } as const;
  }),
);
