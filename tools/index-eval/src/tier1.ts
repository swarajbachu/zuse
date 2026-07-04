import { Effect } from "effect";

import {
  fetchChunk,
  type IndexDb,
  listFileSymbols,
  lookupSymbol,
} from "@zuse/index";

import { type EvalTask } from "./tasks.ts";
import { type RunResult } from "./types.ts";

const CHARS_PER_TOKEN = 4;

const charsOf = (s: string): number => s.length;

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(eff as Effect.Effect<A, E, never>);

/**
 * Tier-1 path: `symbol_lookup(name)` → optional `read_chunk(chunkId)`.
 * The agent doesn't need to grep, doesn't need to read the whole file —
 * the chunk contains the function body bounded by tree-sitter.
 */
export const runTier1Task = async (
  db: IndexDb,
  branch: string,
  task: EvalTask,
): Promise<RunResult> => {
  const t0 = Date.now();
  const toolCalls: string[] = [];
  let inputChars = 0;

  const lookupCall = `symbol_lookup(${JSON.stringify({
    name: task.symbol ?? task.id,
  })})`;
  toolCalls.push(lookupCall);
  inputChars += charsOf(lookupCall);

  const hits = await run(
    lookupSymbol(db, task.symbol ?? task.id, branch, undefined, 5),
  );
  const hitsJson = JSON.stringify(hits.slice(0, 3));
  inputChars += charsOf(hitsJson);

  let succeeded = false;
  let notes = "";

  if (hits.length > 0 && hits[0]) {
    const top = hits[0];
    const norm = top.file;
    if (task.acceptableFiles.some((af) => norm === af || norm.endsWith(af))) {
      succeeded = true;
    }
    notes = top.file;

    // The agent would now read the surrounding chunk. We look up *any*
    // chunk whose symbol_id matches the hit. Mimic via listFileSymbols +
    // the synthetic content for the top symbol — in the real flow the
    // SDK tool returns the chunk content directly.
    const summary = await run(listFileSymbols(db, top.file, branch));
    const summaryJson = JSON.stringify(summary.slice(0, 5));
    inputChars += charsOf(summaryJson);

    // Read a chunk if a usable id is available — fall through silently
    // when the symbol has no matched chunk row (e.g. type aliases).
    const chunkId = (top as { chunkId?: number }).chunkId ?? -1;
    if (chunkId >= 0) {
      const chunk = await run(fetchChunk(db, chunkId, branch));
      if (chunk) inputChars += charsOf(JSON.stringify(chunk).slice(0, 4000));
    }
  }

  const outputChars = 80;
  const totalChars = inputChars + outputChars;

  return {
    taskId: task.id,
    tier: "tier1",
    succeeded,
    tokens: Math.round(totalChars / CHARS_PER_TOKEN),
    wallMs: Date.now() - t0,
    toolCalls: toolCalls.length,
    notes,
  };
};
