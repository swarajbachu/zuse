import { formatTokens, formatUsd } from "./pricing.ts";
import type { UsageGroup, UsageReport } from "./types.ts";

const totalTokens = (group: UsageGroup): number =>
  group.inputTokens +
  group.outputTokens +
  group.cacheReadTokens +
  group.cacheCreationTokens +
  group.reasoningTokens;

export const reportToJson = (report: UsageReport): string =>
  JSON.stringify(
    report,
    (_key, value) => (value instanceof Date ? value.toISOString() : value),
    2,
  );

export const renderTextReport = (
  report: UsageReport,
  options: { noCost?: boolean } = {},
): string => {
  const rows = report.groups;
  const headers = options.noCost
    ? ["period", "records", "input", "output", "cache", "reason", "total"]
    : ["period", "records", "input", "output", "cache", "reason", "total", "cost"];
  const body = rows.map((row) => {
    const values = [
      row.label,
      String(row.recordCount),
      formatTokens(row.inputTokens),
      formatTokens(row.outputTokens),
      formatTokens(row.cacheReadTokens + row.cacheCreationTokens),
      formatTokens(row.reasoningTokens),
      formatTokens(totalTokens(row)),
    ];
    if (!options.noCost) values.push(formatUsd(row.costUsd));
    return values;
  });
  const summary = report.summary;
  const footer = [
    "TOTAL",
    String(summary.recordCount),
    formatTokens(summary.inputTokens),
    formatTokens(summary.outputTokens),
    formatTokens(summary.cacheReadTokens + summary.cacheCreationTokens),
    formatTokens(summary.reasoningTokens),
    formatTokens(
      summary.inputTokens +
        summary.outputTokens +
        summary.cacheReadTokens +
        summary.cacheCreationTokens +
        summary.reasoningTokens,
    ),
  ];
  if (!options.noCost) footer.push(formatUsd(summary.costUsd));
  const allRows = [headers, ...body, footer];
  const widths = headers.map((_, i) =>
    Math.max(...allRows.map((row) => row[i]?.length ?? 0)),
  );
  return allRows
    .map((row, index) => {
      const line = row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ");
      return index === 1 ? `${"-".repeat(line.length)}\n${line}` : line;
    })
    .join("\n");
};
