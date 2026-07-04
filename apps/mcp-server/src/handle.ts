import { Effect } from "effect";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  branchExists,
  closeIndexDb,
  countAll,
  fetchChunk,
  findReferencesByName,
  indexRepo,
  listFileSymbols,
  lookupSymbol,
  openIndexDb,
  reindexFile,
  runMigrations,
  search,
  type IndexDb,
  type SearchHit,
  type SearchInput,
} from "@zuse/index";

const runP = <A>(eff: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(eff as Effect.Effect<A, unknown, never>);

export interface ServerOptions {
  readonly workspace: string;
  readonly branch?: string;
  readonly dbPath?: string;
}

export interface ServerHandle {
  readonly db: IndexDb;
  readonly workspace: string;
  readonly branch: string;
  readonly status: () => Promise<{
    readonly workspace: string;
    readonly branch: string;
    readonly dbPath: string;
    readonly populated: boolean;
    readonly stats: { blobs: number; chunks: number; symbols: number; refs: number };
  }>;
  readonly reindex: () => Promise<{ readonly processed: number }>;
  readonly reindexFile: (
    path: string,
  ) => Promise<{ readonly blobId: number; readonly parsed: boolean }>;
  readonly search: (input: SearchInput) => Promise<ReadonlyArray<SearchHit>>;
  readonly symbolLookup: (input: {
    readonly name: string;
    readonly kind?: string;
    readonly limit?: number;
    readonly pathGlob?: string;
  }) => Promise<unknown>;
  readonly findReferences: (input: {
    readonly symbol: string;
    readonly limit?: number;
    readonly pathGlob?: string;
  }) => Promise<unknown>;
  readonly readChunk: (input: {
    readonly chunkId: number;
  }) => Promise<unknown>;
  readonly listModule: (input: { readonly path: string }) => Promise<unknown>;
  readonly close: () => Promise<void>;
}

/**
 * Open the per-workspace index DB and surface the tool functions the
 * MCP server registers. Same shape as `apps/server`'s IndexHandle so
 * the two consumption paths share semantics — the only difference is
 * MCP serialization vs. in-process function calls.
 */
export const startServerHandle = async (
  opts: ServerOptions,
): Promise<ServerHandle> => {
  const workspace = opts.workspace;
  const branch = opts.branch ?? "HEAD";
  const dbPath = opts.dbPath ?? join(workspace, ".zuse", "index.sqlite");

  if (!existsSync(workspace)) {
    throw new Error(`workspace not found: ${workspace}`);
  }

  const db = await runP(openIndexDb(dbPath));
  await runP(runMigrations(db));

  return {
    db,
    workspace,
    branch,
    status: async () => {
      const populated = await runP(branchExists(db, branch));
      const stats = await runP(countAll(db));
      return { workspace, branch, dbPath, populated, stats };
    },
    reindex: async () => runP(indexRepo(db, workspace, branch)),
    reindexFile: async (path: string) =>
      runP(reindexFile(db, workspace, path, branch)),
    search: (input) => runP(search(db, branch, input)),
    symbolLookup: ({ name, kind, limit, pathGlob }) =>
      runP(lookupSymbol(db, name, branch, kind, limit ?? 10, pathGlob)),
    findReferences: ({ symbol, limit, pathGlob }) =>
      runP(findReferencesByName(db, symbol, branch, limit ?? 20, pathGlob)),
    readChunk: ({ chunkId }) => runP(fetchChunk(db, chunkId, branch)),
    listModule: ({ path }) => runP(listFileSymbols(db, path, branch)),
    close: async () => {
      await runP(closeIndexDb(db));
    },
  };
};
