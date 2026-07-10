import { beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";

import type { UsageReport } from "@zuse/wire";

let reportCalls: Array<{ readonly bucket?: string; readonly forceRefresh?: boolean }> = [];
let pendingReports: Array<{
  readonly resolve: (report: UsageReport) => void;
  readonly reject: (error: unknown) => void;
}> = [];

const { setUsageRpcClientForTest, useUsageStore } = await import("../src/store/usage.ts");

setUsageRpcClientForTest(
  async () =>
    ({
    usage: {
      report: (payload: { readonly bucket?: string; readonly forceRefresh?: boolean }) => {
        reportCalls.push(payload);
        return Effect.promise(
          () =>
            new Promise<UsageReport>((resolve, reject) => {
              pendingReports.push({ resolve, reject });
            }),
        );
      },
    },
  }) as Awaited<ReturnType<typeof import("../src/lib/rpc-client.ts").getRpcClient>>,
);

const makeReport = (recordCount: number): UsageReport =>
  ({
    bucket: "daily",
    generatedAt: new Date("2026-06-21T00:00:00.000Z"),
    summary: {
      inputTokens: recordCount,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      costUsd: null,
      costStatus: "unknown",
      recordCount,
      possibleDuplicateCount: 0,
    },
    groups: [],
    bySource: [],
    byModel: [],
    bySession: [],
    records: [],
    sources: [],
  }) as UsageReport;

describe("usage store", () => {
  beforeEach(() => {
    reportCalls = [];
    pendingReports = [];
    useUsageStore.setState({
      report: null,
      loading: false,
      error: null,
      bucket: "daily",
      requestId: 0,
    });
  });

  it("keeps the newest usage response when older requests resolve later", async () => {
    const first = useUsageStore.getState().refresh(null);
    const second = useUsageStore.getState().refresh(null);
    await Promise.resolve();

    expect(pendingReports).toHaveLength(2);
    pendingReports[1]!.resolve(makeReport(2));
    await second;
    expect(useUsageStore.getState().report?.summary.recordCount).toBe(2);

    pendingReports[0]!.resolve(makeReport(1));
    await first;
    expect(useUsageStore.getState().report?.summary.recordCount).toBe(2);
  });

  it("passes forceRefresh only for explicit refreshes", async () => {
    const request = useUsageStore.getState().refresh(null, { forceRefresh: true });
    await Promise.resolve();

    expect(reportCalls[0]?.forceRefresh).toBe(true);
    pendingReports[0]!.resolve(makeReport(1));
    await request;
  });
});
