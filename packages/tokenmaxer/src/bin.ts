#!/usr/bin/env node
import { createUsageReport, renderTextReport, reportToJson } from "./index.ts";
import { ALL_SOURCE_IDS, SOURCE_LABELS } from "./sources/catalog.ts";
import type { UsageBucket, UsageSourceId } from "./types.ts";

const BUCKETS = new Set(["daily", "weekly", "monthly", "session"]);
const SOURCES = new Set<UsageSourceId>(ALL_SOURCE_IDS);

interface CliOptions {
  bucket: UsageBucket | "sources";
  sourceIds: UsageSourceId[];
  since?: Date;
  until?: Date;
  timezone?: string;
  json: boolean;
  noCost: boolean;
  offline: boolean;
  memoizeDbPath?: string;
}

const usage = (): string => `tokenmaxer [source] [daily|weekly|monthly|session|sources] [options]

Sources: ${ALL_SOURCE_IDS.join(", ")}
  e.g. "tokenmaxer claude daily", "tokenmaxer codex monthly", "tokenmaxer daily" (all)

Options:
  --source <id,id>       Limit sources (repeatable / comma-separated)
  --since <date>         Include records ending on/after date
  --until <date>         Include records starting on/before date
  --timezone <tz>        Timezone for date buckets
  --json                 Print JSON
  --no-cost              Hide cost column
  --offline              Use bundled pricing; skip the network
  --memoize-db <path>    Memoize SQLite path
`;

const parseDate = (value: string): Date => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
};

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {
    bucket: "daily",
    sourceIds: [],
    json: false,
    noCost: false,
    offline: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--help":
      case "-h":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        break;
      case "--json":
        options.json = true;
        break;
      case "--no-cost":
        options.noCost = true;
        break;
      case "--offline":
        options.offline = true;
        break;
      case "--source":
        options.sourceIds.push(...parseSourceList(next()));
        break;
      case "--since":
        options.since = parseDate(next());
        break;
      case "--until":
        options.until = parseDate(next());
        break;
      case "--timezone":
        options.timezone = next();
        break;
      case "--memoize-db":
        options.memoizeDbPath = next();
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown argument: ${arg}`);
        positional.push(arg);
    }
  }

  // Positional args may be a source id and/or a bucket, in any order.
  for (const token of positional) {
    if (SOURCES.has(token as UsageSourceId)) {
      options.sourceIds.push(token as UsageSourceId);
    } else if (BUCKETS.has(token) || token === "sources") {
      options.bucket = token as CliOptions["bucket"];
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return options;
};

const parseSourceList = (value: string): UsageSourceId[] =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (!SOURCES.has(s as UsageSourceId)) throw new Error(`Unknown source: ${s}`);
      return s as UsageSourceId;
    });

const main = async (): Promise<void> => {
  try {
    const options = parseArgs(process.argv.slice(2));
    const sourceIds = options.sourceIds.length ? Array.from(new Set(options.sourceIds)) : undefined;
    const readOptions = { sourceIds, memoizeDbPath: options.memoizeDbPath };
    const pricing = { offline: options.offline };

    if (options.bucket === "sources") {
      const report = await createUsageReport({ readOptions, pricing });
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report.sources, null, 2)}\n`);
        return;
      }
      for (const source of report.sources) {
        const state = source.detected ? `${source.recordCount} records` : "not found";
        const warning = source.warning ? ` (${source.warning})` : "";
        process.stdout.write(
          `${source.id.padEnd(10)} ${SOURCE_LABELS[source.id].padEnd(14)} ${state}${warning}\n`,
        );
      }
      return;
    }

    const report = await createUsageReport({
      bucket: options.bucket,
      filters: {
        bucket: options.bucket,
        sourceIds,
        since: options.since,
        until: options.until,
        timezone: options.timezone,
        noCost: options.noCost,
      },
      readOptions,
      pricing,
    });
    process.stdout.write(
      options.json
        ? `${reportToJson(report)}\n`
        : `${renderTextReport(report, { noCost: options.noCost })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}`);
    process.exit(1);
  }
};

void main();
