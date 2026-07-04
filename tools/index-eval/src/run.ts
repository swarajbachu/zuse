import { Effect } from "effect";
import { resolve } from "node:path";

import {
  closeIndexDb,
  indexRepo,
  openIndexDb,
  runMigrations,
} from "@zuse/index";

import { runBaseline } from "./baseline.ts";
import { TASKS } from "./tasks.ts";
import { runTier1Task } from "./tier1.ts";
import { type RunResult } from "./types.ts";

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(eff as Effect.Effect<A, E, never>);

const argTier = (() => {
  const idx = process.argv.indexOf("--tier");
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1]!;
  return null;
})();

const formatTable = (rows: ReadonlyArray<RunResult>): string => {
  const lines: string[] = [];
  lines.push("taskId,tier,succeeded,tokens,wallMs,toolCalls,notes");
  for (const r of rows) {
    lines.push(
      [
        r.taskId,
        r.tier,
        r.succeeded ? "1" : "0",
        r.tokens,
        r.wallMs,
        r.toolCalls,
        JSON.stringify(r.notes),
      ].join(","),
    );
  }
  return lines.join("\n");
};

const summary = (
  baseline: ReadonlyArray<RunResult>,
  tier1: ReadonlyArray<RunResult>,
) => {
  const byId = new Map(tier1.map((r) => [r.taskId, r]));
  let beats = 0;
  let succeeded = 0;
  let tier1Total = 0;
  let baselineTotal = 0;
  for (const b of baseline) {
    const t = byId.get(b.taskId);
    if (!t) continue;
    baselineTotal += b.tokens;
    tier1Total += t.tokens;
    if (t.succeeded) succeeded++;
    if (t.tokens <= b.tokens / 2) beats++;
  }
  const ratio = baselineTotal === 0 ? 0 : tier1Total / baselineTotal;
  return {
    tasks: baseline.length,
    beats,
    succeeded,
    successRate: succeeded / baseline.length,
    tokenRatio: ratio,
    underHalfRate: beats / baseline.length,
  };
};

const main = async () => {
  const repoRoot = resolve(__dirname, "..", "..", "..");
  const branch = "HEAD";

  const baseline =
    argTier === "1" ? [] : runBaseline(repoRoot, TASKS);

  let tier1: ReadonlyArray<RunResult> = [];
  if (argTier !== "0") {
    const db = await run(openIndexDb(":memory:"));
    await run(runMigrations(db));
    process.stderr.write("Indexing repo …\n");
    await run(indexRepo(db, repoRoot, branch));
    process.stderr.write("Running Tier 1 …\n");
    const out: RunResult[] = [];
    for (const task of TASKS) {
      out.push(await runTier1Task(db, branch, task));
    }
    tier1 = out;
    await run(closeIndexDb(db));
  }

  const all = [...baseline, ...tier1];
  process.stdout.write(formatTable(all) + "\n");

  if (baseline.length > 0 && tier1.length > 0) {
    const s = summary(baseline, tier1);
    process.stderr.write("\n");
    process.stderr.write(
      `success=${(s.successRate * 100).toFixed(1)}% (${s.succeeded}/${s.tasks})\n`,
    );
    process.stderr.write(
      `tier1 tokens / baseline tokens = ${(s.tokenRatio * 100).toFixed(1)}%\n`,
    );
    process.stderr.write(
      `tasks where tier1 uses ≤50% baseline tokens: ${s.beats}/${s.tasks} (${(
        s.underHalfRate * 100
      ).toFixed(1)}%)\n`,
    );
    const passGate = s.underHalfRate >= 0.7;
    process.stderr.write(
      `GATE: ${passGate ? "PASS" : "FAIL"} (≥70% of tasks under 50% baseline)\n`,
    );
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
