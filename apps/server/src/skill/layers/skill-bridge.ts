import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect, Layer, PubSub, Stream } from "effect";

import type { ProviderId, Skill } from "@zuse/contracts";

import { MessageStore } from "../../provider/services/message-store.ts";
import { WorkspaceService } from "../../workspace/services/workspace-service.ts";
import { SkillBridge } from "../services/skill-bridge.ts";
import { SkillDiscoveryService } from "../services/skill-discovery.ts";

/**
 * Cache key — one set of skills per provider+projectCwd. The same cwd /
 * provider pair is shared by every session in that project, so we don't
 * re-walk disk per session.
 */
const cacheKey = (providerId: ProviderId, projectCwd: string): string =>
  `${providerId}:${projectCwd}`;

/**
 * Watch the directory roots that influence a `(providerId, projectCwd)`
 * pair and call `onChange` (debounced) whenever anything changes. Failing
 * watchers are silently dropped — discovery is best-effort, and we'd
 * rather miss a hot-reload than crash the bridge.
 */
const watchRoots = (
  providerId: ProviderId,
  projectCwd: string,
  onChange: () => void,
): (() => void) => {
  const home = os.homedir();
  const roots =
    providerId === "claude"
      ? [
          path.join(home, ".claude", "skills"),
          path.join(home, ".claude", "plugins"),
          path.join(projectCwd, ".claude", "skills"),
        ]
      : [
          path.join(home, ".codex", "skills"),
          path.join(home, ".codex", "prompts"),
          path.join(projectCwd, ".codex", "skills"),
          path.join(projectCwd, ".codex", "prompts"),
        ];

  const watchers: fsSync.FSWatcher[] = [];
  let timer: NodeJS.Timeout | null = null;
  const fire = (): void => {
    if (timer !== null) clearTimeout(timer);
    // Debounce: editors save by writing twice or rotating files; coalesce
    // a flurry into a single discovery pass.
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, 250);
  };

  for (const root of roots) {
    try {
      const w = fsSync.watch(root, { recursive: true }, fire);
      w.on("error", () => {
        /* ignore — root may not exist yet */
      });
      watchers.push(w);
    } catch {
      // Root doesn't exist or isn't watchable — fine. If the user creates
      // it later we'll miss the hot-reload until next list call; pragmatic
      // tradeoff to keep the watcher set bounded.
    }
  }

  return () => {
    if (timer !== null) clearTimeout(timer);
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
  };
};

export const SkillBridgeLive = Layer.effect(
  SkillBridge,
  Effect.gen(function* () {
    const discovery = yield* SkillDiscoveryService;
    const store = yield* MessageStore;
    const workspace = yield* WorkspaceService;

    interface CacheEntry {
      readonly skills: ReadonlyArray<Skill>;
      readonly stop: () => void;
      readonly hub: PubSub.PubSub<ReadonlyArray<Skill>>;
    }
    const cache = new Map<string, CacheEntry>();

    const ensureEntry = (
      providerId: ProviderId,
      projectCwd: string,
    ): Effect.Effect<CacheEntry> =>
      Effect.gen(function* () {
        const key = cacheKey(providerId, projectCwd);
        const existing = cache.get(key);
        if (existing !== undefined) return existing;

        const initial = yield* discovery.discover(providerId, projectCwd);
        const hub = yield* PubSub.unbounded<ReadonlyArray<Skill>>();
        const entry: CacheEntry = {
          skills: initial,
          stop: () => undefined,
          hub,
        };
        cache.set(key, entry);

        const stop = watchRoots(providerId, projectCwd, () => {
          // Re-discover and republish on watcher fire. Effect.runFork is
          // safe here — the entry's hub outlives any one publish.
          Effect.runFork(
            Effect.gen(function* () {
              const next = yield* discovery.discover(providerId, projectCwd);
              const cur = cache.get(key);
              if (cur === undefined) return;
              cache.set(key, { ...cur, skills: next });
              yield* PubSub.publish(hub, next);
            }),
          );
        });
        cache.set(key, { ...entry, stop });
        return cache.get(key)!;
      });

    const resolveSession = (
      sessionId: Parameters<SkillBridge["Service"]["list"]>[0],
    ) =>
      Effect.gen(function* () {
        const session = yield* store.getSession(sessionId);
        const folder = yield* workspace.findById(session.projectId);
        // If the workspace row has gone missing fall back to cwd — the
        // discovery pass will simply find no project-scoped skills.
        const projectCwd = folder?.path ?? process.cwd();
        return { providerId: session.providerId, projectCwd };
      });

    const list: SkillBridge["Service"]["list"] = (sessionId) =>
      Effect.gen(function* () {
        const { providerId, projectCwd } = yield* resolveSession(sessionId);
        const entry = yield* ensureEntry(providerId, projectCwd);
        return entry.skills;
      });

    const listForProject: SkillBridge["Service"]["listForProject"] = (
      projectId,
      providerId,
    ) =>
      Effect.gen(function* () {
        const folder = yield* workspace.findById(projectId);
        const projectCwd = folder?.path ?? process.cwd();
        const entry = yield* ensureEntry(providerId, projectCwd);
        return entry.skills;
      });

    const stream: SkillBridge["Service"]["stream"] = (sessionId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const { providerId, projectCwd } = yield* resolveSession(sessionId);
          const entry = yield* ensureEntry(providerId, projectCwd);
          // Emit the current list immediately, then any future republishes.
          // The renderer treats each emission as the full list (no diffs).
          return Stream.concat(
            Stream.succeed(entry.skills),
            Stream.fromPubSub(entry.hub),
          );
        }),
      );

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const entry of cache.values()) entry.stop();
        cache.clear();
      }),
    );

    return { list, listForProject, stream };
  }),
);
