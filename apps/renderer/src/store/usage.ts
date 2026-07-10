import { Effect } from "effect";
import { create } from "zustand";

import type { FolderId, UsageBucket, UsageReport } from "@zuse/contracts";

import { getRpcClient } from "../lib/rpc-client.ts";

let getUsageRpcClient: typeof getRpcClient = getRpcClient;

export const setUsageRpcClientForTest = (fn: typeof getRpcClient): void => {
  getUsageRpcClient = fn;
};

type UsageState = {
  readonly report: UsageReport | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly bucket: UsageBucket;
  readonly requestId: number;
  readonly refresh: (
    projectId: FolderId | null,
    opts?: { readonly forceRefresh?: boolean },
  ) => Promise<void>;
  readonly setBucket: (bucket: UsageBucket, projectId: FolderId | null) => Promise<void>;
};

export const useUsageStore = create<UsageState>((set, get) => ({
  report: null,
  loading: false,
  error: null,
  bucket: "daily",
  requestId: 0,
  refresh: async (projectId, opts) => {
    const bucket = get().bucket;
    const requestId = get().requestId + 1;
    set({ loading: true, error: null, requestId });
    try {
      const client = await getUsageRpcClient();
      const report = await Effect.runPromise(
        client["usage.report"]({
          bucket,
          projectId: projectId ?? undefined,
          forceRefresh: opts?.forceRefresh,
        }),
      );
      if (get().requestId !== requestId) return;
      set({ report, loading: false });
    } catch (error) {
      if (get().requestId !== requestId) return;
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
  setBucket: async (bucket, projectId) => {
    set({ bucket });
    await get().refresh(projectId);
  },
}));
