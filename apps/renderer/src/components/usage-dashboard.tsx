import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Info,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type {
  FolderId,
  UsageBucket,
  UsageGroup,
  UsageReport,
  UsageSourceStatus,
} from "@zuse/contracts";

import { cn } from "~/lib/utils";
import {
  cacheTokens,
  formatTokens,
  formatUsd,
  totalTokens,
  type TokenRow,
} from "~/lib/format-usage.ts";
import { Button } from "./ui/button.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";
import {
  Frame,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "./ui/frame.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table.tsx";
import { useUsageStore } from "../store/usage.ts";

const BUCKETS: ReadonlyArray<UsageBucket> = [
  "daily",
  "weekly",
  "monthly",
  "session",
];
const PAGE_SIZE = 10;

/** Token-type series used for the stacked chart, legend, and tooltip. */
const SERIES: ReadonlyArray<{
  readonly key: string;
  readonly label: string;
  readonly bar: string;
  readonly dot: string;
  readonly value: (r: TokenRow) => number;
}> = [
  {
    key: "input",
    label: "Input",
    bar: "bg-primary",
    dot: "bg-primary",
    value: (r) => r.inputTokens,
  },
  {
    key: "output",
    label: "Output",
    bar: "bg-primary/65",
    dot: "bg-primary/65",
    value: (r) => r.outputTokens,
  },
  {
    key: "cache",
    label: "Cache",
    bar: "bg-primary/35",
    dot: "bg-primary/35",
    value: cacheTokens,
  },
  {
    key: "reasoning",
    label: "Reasoning",
    bar: "bg-primary/20",
    dot: "bg-primary/20",
    value: (r) => r.reasoningTokens,
  },
];

export function UsageDashboard({
  projectId,
  scopeLabel,
}: {
  projectId: FolderId | null;
  scopeLabel: string;
}) {
  const report = useUsageStore((s) => s.report);
  const loading = useUsageStore((s) => s.loading);
  const error = useUsageStore((s) => s.error);
  const bucket = useUsageStore((s) => s.bucket);
  const refresh = useUsageStore((s) => s.refresh);
  const setBucket = useUsageStore((s) => s.setBucket);

  useEffect(() => {
    void refresh(projectId);
  }, [projectId, refresh]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <div>
          <div className="text-sm font-medium">Tokenmaxer · {scopeLabel}</div>
          <div className="text-[11px] text-muted-foreground">
            Local token usage across Zuse Alpha and detected agent CLIs
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refresh(projectId, { forceRefresh: true })}
          className="inline-flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground"
          title="Refresh usage"
          aria-label="Refresh usage"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </button>
      </div>

      {error !== null ? (
        <div className="m-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {report === null ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {loading ? (
            <ShimmerText>Loading usage…</ShimmerText>
          ) : (
            "No usage report loaded."
          )}
        </div>
      ) : (
        <UsageReportView
          report={report}
          bucket={bucket}
          onBucket={(b) => void setBucket(b, projectId)}
        />
      )}
    </div>
  );
}

function UsageReportView({
  report,
  bucket,
  onBucket,
}: {
  report: UsageReport;
  bucket: UsageBucket;
  onBucket: (bucket: UsageBucket) => void;
}) {
  const summary = report.summary;
  const metrics = useMemo(
    () => [
      {
        label: "Total cost",
        value: formatUsd(summary.costUsd),
        hint: costHint(summary.costStatus),
      },
      {
        label: "Total tokens",
        value: formatTokens(totalTokens(summary)),
        hint: `${summary.recordCount.toLocaleString()} records`,
      },
      {
        label: "Input / Output",
        value: `${formatTokens(summary.inputTokens)} / ${formatTokens(summary.outputTokens)}`,
        hint: undefined,
      },
      {
        label: "Cache",
        value: formatTokens(cacheTokens(summary)),
        hint:
          summary.reasoningTokens > 0
            ? `${formatTokens(summary.reasoningTokens)} reasoning`
            : undefined,
      },
    ],
    [summary],
  );
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
      <Frame>
        <FramePanel className="grid grid-cols-2 p-0 sm:grid-cols-4">
          {metrics.map((m, i) => (
            <Metric key={m.label} {...m} divided={i > 0} />
          ))}
        </FramePanel>
      </Frame>

      <Section title="Sources">
        <div className="flex flex-wrap gap-2">
          {report.sources.map((source) => (
            <SourceChip key={source.id} source={source} />
          ))}
        </div>
      </Section>

      <UsageChart groups={report.groups} bucket={bucket} onBucket={onBucket} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Breakdown title="By source" rows={report.bySource} max={8} />
        <Breakdown title="By model" rows={report.byModel} max={12} />
      </div>

      <SessionsTable rows={report.bySession} />
    </div>
  );
}

function costHint(
  status: UsageReport["summary"]["costStatus"],
): string | undefined {
  if (status === "partial") return "some models unpriced";
  if (status === "unknown") return "pricing unavailable";
  return undefined;
}

function Metric({
  label,
  value,
  hint,
  divided,
}: {
  label: string;
  value: string;
  hint?: string;
  divided?: boolean;
}) {
  return (
    <div className={cn("p-4", divided && "sm:border-l sm:border-border/60")}>
      <div className="text-[11px] font-medium text-muted-foreground">
        {label}
      </div>
      <div
        className="mt-1.5 truncate text-2xl font-semibold tracking-tight tabular-nums"
        title={value}
      >
        {value}
      </div>
      <div className="mt-1 h-3.5 text-[10px] text-muted-foreground">
        {hint ?? ""}
      </div>
    </div>
  );
}

function BucketSelector({
  value,
  onChange,
}: {
  value: UsageBucket;
  onChange: (bucket: UsageBucket) => void;
}) {
  return (
    <div className="flex rounded-md border border-border p-0.5">
      {BUCKETS.map((b) => (
        <button
          key={b}
          type="button"
          onClick={() => onChange(b)}
          className={cn(
            "rounded px-2 py-1 text-[11px] capitalize transition-colors",
            value === b
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {b}
        </button>
      ))}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-2 text-[12px] font-medium uppercase tracking-normal text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function SourceChip({ source }: { source: UsageSourceStatus }) {
  const active = source.detected && source.recordCount > 0;
  const dotColor = active
    ? "bg-emerald-500"
    : source.detected
      ? "bg-amber-500"
      : "bg-muted-foreground/40";
  // Show the caveat (e.g. Memoize counts under the CLIs, Grok undercount) inline
  // so a low/zero number reads as "expected", not "broken".
  const hasNote = source.warning !== null && source.detected;
  const title =
    source.warning ??
    (source.detected ? `${source.recordCount} records` : "Not found");
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px]",
        !active && "opacity-60",
      )}
      title={title}
    >
      <span className={cn("size-1.5 rounded-full", dotColor)} />
      <span className="font-medium">{source.label}</span>
      <span className="tabular-nums text-muted-foreground">
        {source.detected ? source.recordCount.toLocaleString() : "—"}
      </span>
      {hasNote ? (
        <Info className="size-3 text-muted-foreground/70" aria-label={title} />
      ) : null}
    </div>
  );
}

function UsageChart({
  groups,
  bucket,
  onBucket,
}: {
  groups: ReadonlyArray<UsageGroup>;
  bucket: UsageBucket;
  onBucket: (bucket: UsageBucket) => void;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  // Keep the most recent window so date buckets stay readable.
  const visible = useMemo(() => groups.slice(-60), [groups]);
  const peak = Math.max(1, ...visible.map(totalTokens));

  return (
    <Frame>
      <FrameHeader className="flex-row items-center justify-between gap-3 px-4 py-3">
        <FrameTitle>Usage over time</FrameTitle>
        <BucketSelector value={bucket} onChange={onBucket} />
      </FrameHeader>
      <FramePanel>
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
          {SERIES.map((s) => (
            <div
              key={s.key}
              className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
            >
              <span className={cn("size-2 rounded-[2px]", s.dot)} />
              {s.label}
            </div>
          ))}
        </div>

        {visible.length === 0 ? (
          <div className="flex h-44 items-center justify-center text-sm text-muted-foreground">
            No usage rows found.
          </div>
        ) : (
          <div className="relative">
            {hovered !== null && visible[hovered] !== undefined ? (
              <ChartTooltip
                group={visible[hovered]}
                index={hovered}
                count={visible.length}
              />
            ) : null}
            <div className="flex h-44 items-end gap-[3px] border-b border-border/60">
              {visible.map((group, index) => (
                <div
                  key={group.key}
                  className="group flex h-full min-w-[3px] flex-1 cursor-default flex-col-reverse overflow-hidden rounded-t-[3px]"
                  onMouseEnter={() => setHovered(index)}
                  onMouseLeave={() =>
                    setHovered((h) => (h === index ? null : h))
                  }
                >
                  {SERIES.map((s) => {
                    const value = s.value(group);
                    if (value <= 0) return null;
                    return (
                      <div
                        key={s.key}
                        className={cn(
                          s.bar,
                          "transition-opacity",
                          hovered !== null && hovered !== index
                            ? "opacity-30"
                            : "group-hover:brightness-110",
                        )}
                        style={{ height: `${(value / peak) * 100}%` }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
              <span>{visible[0]?.label}</span>
              <span>{visible[visible.length - 1]?.label}</span>
            </div>
          </div>
        )}
      </FramePanel>
    </Frame>
  );
}

function ChartTooltip({
  group,
  index,
  count,
}: {
  group: UsageGroup;
  index: number;
  count: number;
}) {
  const left = Math.min(Math.max(((index + 0.5) / count) * 100, 14), 86);
  return (
    <div
      className="pointer-events-none absolute bottom-full z-10 mb-2 w-48 -translate-x-1/2 rounded-md border border-border bg-popover p-2.5 text-popover-foreground shadow-md"
      style={{ left: `${left}%` }}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="truncate text-[11px] font-medium" title={group.label}>
          {group.label}
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {formatUsd(group.costUsd)}
        </span>
      </div>
      <div className="mb-1.5 flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">Total tokens</span>
        <span className="font-medium tabular-nums">
          {formatTokens(totalTokens(group))}
        </span>
      </div>
      <div className="space-y-1 border-t border-border/60 pt-1.5">
        {SERIES.filter((s) => s.value(group) > 0).map((s) => (
          <div
            key={s.key}
            className="flex items-center justify-between text-[11px]"
          >
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span className={cn("size-1.5 rounded-full", s.dot)} />
              {s.label}
            </span>
            <span className="tabular-nums">{formatTokens(s.value(group))}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Breakdown({
  title,
  rows,
  max,
}: {
  title: string;
  rows: ReadonlyArray<UsageGroup>;
  max: number;
}) {
  const visible = useMemo(
    () =>
      rows
        .slice()
        .sort((a, b) => totalTokens(b) - totalTokens(a))
        .slice(0, max),
    [rows, max],
  );
  const peak = Math.max(1, ...visible.map(totalTokens));
  return (
    <Frame>
      <FrameHeader className="px-3 py-2.5">
        <FrameTitle className="text-[12px] uppercase tracking-normal text-muted-foreground">
          {title}
        </FrameTitle>
      </FrameHeader>
      <FramePanel className="overflow-hidden p-0">
        {visible.length === 0 ? (
          <div className="p-3 text-sm text-muted-foreground">No data.</div>
        ) : (
          visible.map((row) => (
            <div
              key={row.key}
              className="relative border-b border-border/50 last:border-0"
            >
              <div
                className="absolute inset-y-0 left-0 bg-primary/[0.10]"
                style={{ width: `${(totalTokens(row) / peak) * 100}%` }}
              />
              <div className="relative flex items-center justify-between px-3 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-[12px]" title={row.label}>
                    {row.label}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {row.recordCount.toLocaleString()} records
                  </div>
                </div>
                <div className="ml-3 shrink-0 text-right text-[12px] tabular-nums">
                  <div>{formatTokens(totalTokens(row))}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {formatUsd(row.costUsd)}
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </FramePanel>
    </Frame>
  );
}

type SortKey = "tokens" | "cost";

function SessionsTable({ rows }: { rows: ReadonlyArray<UsageGroup> }) {
  const [sortKey, setSortKey] = useState<SortKey>("tokens");
  const [pageIndex, setPageIndex] = useState(0);

  const sorted = useMemo(() => {
    const value = (r: UsageGroup) =>
      sortKey === "cost" ? (r.costUsd ?? 0) : totalTokens(r);
    if (sortKey === "tokens") return rows;
    return rows.slice().sort((a, b) => value(b) - value(a));
  }, [rows, sortKey]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const page = Math.min(pageIndex, pageCount - 1);
  const start = page * PAGE_SIZE;
  const visible = sorted.slice(start, start + PAGE_SIZE);

  const toggleSort = (key: SortKey) => {
    setSortKey(key);
    setPageIndex(0);
  };

  if (rows.length === 0) {
    return (
      <Frame>
        <FramePanel className="text-sm text-muted-foreground">
          No sessions found.
        </FramePanel>
      </Frame>
    );
  }

  return (
    <Frame className="w-full">
      <FrameHeader className="px-3 py-2.5">
        <FrameTitle className="text-[12px] uppercase tracking-normal text-muted-foreground">
          Sessions
        </FrameTitle>
      </FrameHeader>
      <Table variant="card" className="table-fixed">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-[46%]">Session</TableHead>
            <TableHead className="w-[18%]">Sources</TableHead>
            <SortableHead
              label="Tokens"
              active={sortKey === "tokens"}
              onClick={() => toggleSort("tokens")}
            />
            <SortableHead
              label="Cost"
              active={sortKey === "cost"}
              onClick={() => toggleSort("cost")}
            />
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((row) => (
            <TableRow key={row.key}>
              <TableCell>
                <div className="truncate font-medium" title={row.label}>
                  {row.label}
                </div>
                <div className="truncate text-[10px] text-muted-foreground">
                  {lastActive(row)}
                </div>
              </TableCell>
              <TableCell className="truncate text-muted-foreground">
                {row.sourceIds.join(", ")}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatTokens(totalTokens(row))}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatUsd(row.costUsd)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <FrameFooter className="p-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">
            {start + 1}–{Math.min(start + PAGE_SIZE, sorted.length)} of{" "}
            <strong className="font-medium text-foreground">
              {sorted.length.toLocaleString()}
            </strong>
          </p>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={page === 0}
              onClick={() => setPageIndex(page - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="px-1 text-[11px] tabular-nums text-muted-foreground">
              {page + 1} / {pageCount}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= pageCount - 1}
              onClick={() => setPageIndex(page + 1)}
              aria-label="Next page"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </FrameFooter>
    </Frame>
  );
}

function lastActive(row: UsageGroup): string {
  const date = row.endedAt ?? row.startedAt;
  return date === null ? "—" : `Last active ${date.toLocaleDateString()}`;
}

function SortableHead({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <TableHead className="w-[18%] text-right">
      <button
        type="button"
        onClick={onClick}
        className="ml-auto flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        {label}
        {active ? (
          <ChevronDown className="size-3.5" />
        ) : (
          <ChevronUp className="size-3.5 opacity-30" />
        )}
      </button>
    </TableHead>
  );
}
