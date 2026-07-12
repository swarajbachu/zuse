import { create } from "zustand";
import { Effect } from "effect";

import type {
  ConvexConnection,
  DeployEvent,
  Deployment,
  FolderId,
  WorktreeId,
} from "@zuse/contracts";

import { getRpcClient } from "../lib/rpc-client.ts";

/**
 * Deploy state per `(folderId, worktreeId)` — same keying as git-status.
 * `latest`/`log` are fed by the `deploy.events` stream (the deploy pane owns
 * the subscription); `refreshLatest` gives the top-bar chip a correct value
 * before the pane has ever been opened.
 */
export const deployKey = (
  folderId: FolderId,
  worktreeId: WorktreeId | null | undefined,
): string => `${folderId}:${worktreeId ?? "main"}`;

interface DeployEntry {
  readonly latest: Deployment | null;
  readonly log: string;
  readonly history: ReadonlyArray<Deployment>;
}

const EMPTY_ENTRY: DeployEntry = { latest: null, log: "", history: [] };

type DeployState = {
  readonly byKey: Record<string, DeployEntry>;
  readonly convexConnection: ConvexConnection | null;
  readonly convexStatusLoaded: boolean;
  readonly applyEvent: (key: string, event: DeployEvent) => void;
  readonly refreshLatest: (
    folderId: FolderId,
    worktreeId: WorktreeId | null,
  ) => Promise<void>;
  readonly refreshHistory: (
    folderId: FolderId,
    worktreeId: WorktreeId | null,
  ) => Promise<void>;
  readonly refreshConvexStatus: () => Promise<void>;
  readonly disconnectConvex: () => Promise<void>;
};

const entryOf = (s: DeployState, key: string): DeployEntry =>
  s.byKey[key] ?? EMPTY_ENTRY;

export const useDeployStore = create<DeployState>((set, get) => ({
  byKey: {},
  convexConnection: null,
  convexStatusLoaded: false,

  applyEvent: (key, event) =>
    set((s) => {
      const entry = entryOf(s, key);
      if (event._tag === "log") {
        return {
          byKey: { ...s.byKey, [key]: { ...entry, log: event.output } },
        };
      }
      const deployment = event.deployment;
      const history = entry.history.some((d) => d.id === deployment.id)
        ? entry.history.map((d) => (d.id === deployment.id ? deployment : d))
        : [deployment, ...entry.history];
      return {
        byKey: {
          ...s.byKey,
          [key]: {
            ...entry,
            latest:
              entry.latest === null ||
              entry.latest.id === deployment.id ||
              deployment.createdAt >= entry.latest.createdAt
                ? deployment
                : entry.latest,
            history,
          },
        },
      };
    }),

  refreshLatest: async (folderId, worktreeId) => {
    const key = deployKey(folderId, worktreeId);
    try {
      const client = await getRpcClient();
      const rows = await Effect.runPromise(
        client["deploy.history"]({ folderId, limit: 5 }),
      );
      const forKey = rows.find(
        (d) => (d.worktreeId ?? null) === (worktreeId ?? null),
      );
      if (forKey !== undefined) {
        set((s) => ({
          byKey: {
            ...s.byKey,
            [key]: { ...entryOf(get(), key), latest: forKey },
          },
        }));
      }
    } catch {
      // Deploy state is decorative in the top bar — ignore load failures.
    }
  },

  refreshHistory: async (folderId, worktreeId) => {
    const key = deployKey(folderId, worktreeId);
    try {
      const client = await getRpcClient();
      const rows = await Effect.runPromise(
        client["deploy.history"]({ folderId, limit: 20 }),
      );
      set((s) => ({
        byKey: { ...s.byKey, [key]: { ...entryOf(get(), key), history: rows } },
      }));
    } catch {
      // Panel shows an empty history on failure.
    }
  },

  refreshConvexStatus: async () => {
    try {
      const client = await getRpcClient();
      const connection = await Effect.runPromise(client["deploy.convexStatus"]({}));
      set({ convexConnection: connection, convexStatusLoaded: true });
    } catch {
      set({ convexStatusLoaded: true });
    }
  },

  disconnectConvex: async () => {
    const client = await getRpcClient();
    await Effect.runPromise(client["deploy.disconnectConvex"]({}));
    set({ convexConnection: null });
  },
}));
