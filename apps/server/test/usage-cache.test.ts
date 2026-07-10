import { beforeEach, describe, expect, it } from "vitest";

import { buildUsageReport, makeUsageRecord, type PricedUsage } from "tokenmaxer";

import {
  loadPricedUsageCached,
  resetUsageReportCacheForTest,
  trimUsageReportForPayload,
} from "../src/usage/handlers.ts";

const emptyUsage = (id: string): PricedUsage => ({
  records: [],
  sources: [
    {
      id: "zuse",
      label: `Zuse Alpha ${id}`,
      detected: true,
      recordCount: 0,
      paths: [],
      warning: null,
    },
  ],
});

describe("usage report cache", () => {
  beforeEach(() => {
    resetUsageReportCacheForTest();
  });

  it("coalesces concurrent cold loads", async () => {
    let calls = 0;
    let resolveLoad: ((value: PricedUsage) => void) | null = null;
    const load = () => {
      calls += 1;
      return new Promise<PricedUsage>((resolve) => {
        resolveLoad = resolve;
      });
    };

    const first = loadPricedUsageCached("/tmp/zuse.sqlite", "/tmp/tokenmaxer", { load });
    const second = loadPricedUsageCached("/tmp/zuse.sqlite", "/tmp/tokenmaxer", { load });

    expect(calls).toBe(1);
    resolveLoad?.(emptyUsage("cold"));
    expect(await first).toBe(await second);
  });

  it("uses fresh cached data unless forceRefresh is set", async () => {
    let calls = 0;
    const load = () => Promise.resolve(emptyUsage(String(++calls)));
    let now = 1_000;

    const first = await loadPricedUsageCached("/tmp/zuse.sqlite", "/tmp/tokenmaxer", {
      load,
      now: () => now,
    });
    now += 1;
    const cached = await loadPricedUsageCached("/tmp/zuse.sqlite", "/tmp/tokenmaxer", {
      load,
      now: () => now,
    });
    const refreshed = await loadPricedUsageCached("/tmp/zuse.sqlite", "/tmp/tokenmaxer", {
      forceRefresh: true,
      load,
      now: () => now,
    });

    expect(calls).toBe(2);
    expect(cached).toBe(first);
    expect(refreshed).not.toBe(first);
  });

  it("trims raw records and caps sessions by token volume", () => {
    const records = Array.from({ length: 300 }, (_, index) =>
      makeUsageRecord({
        sourceId: "zuse",
        sourceLabel: "Zuse Alpha",
        providerId: "codex",
        model: "gpt-5.4",
        sessionId: `session-${index}`,
        startedAt: new Date(1_800_000_000_000 + index),
        counts: { inputTokens: index + 1, outputTokens: 0 },
        provenance: `fixture-${index}`,
      }),
    );
    const report = buildUsageReport({
      records,
      sources: [],
      bucket: "session",
      filters: { includePossibleDuplicates: true },
    });

    const trimmed = trimUsageReportForPayload(report);

    expect(trimmed.records).toEqual([]);
    expect(trimmed.bySession).toHaveLength(250);
    expect(trimmed.bySession[0]?.key).toBe("session-299");
    expect(trimmed.bySession.at(-1)?.key).toBe("session-50");
  });
});
