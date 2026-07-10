/**
 * The 20-task eval harness for the Phase B gate. Each task simulates a
 * typical "agent navigates the repo" question. Two pipelines run against
 * each task:
 *   - **baseline**: grep-only (mimicked by `Bash(rg pattern); Read(file)`)
 *   - **tier1**:    @zuse/index symbol lookup + read_chunk
 *
 * For each pipeline we record:
 *   - `tokens` — sum of input + output token bytes that would have been
 *                shipped to the model (the harness uses character counts
 *                as a proxy; ~4 chars per token)
 *   - `wallMs` — total wall-clock to satisfy the task
 *   - `succeeded` — whether the right file:line range came back
 *
 * Tasks are pinned to a known commit of the memoize repo. If the file
 * has moved, the assertion fails — that's a feature, not a bug; we want
 * the gate to detect drift.
 */

export interface EvalTask {
  readonly id: string;
  readonly question: string;
  /**
   * The "what success looks like" check: the candidate result must contain
   * one of these file paths (path relative to repo root). The harness
   * accepts any of them — some tasks have multiple right answers.
   */
  readonly acceptableFiles: ReadonlyArray<string>;
  /**
   * Symbol the tier-1 pipeline should be able to look up directly. When
   * absent, the task is intended as a text-based ask (BM25 in Phase C).
   */
  readonly symbol?: string;
  /**
   * Substring the baseline grep should match. When absent, the baseline
   * just spends its budget reading candidate files via ls + Read.
   */
  readonly grepPattern?: string;
}

export const TASKS: ReadonlyArray<EvalTask> = [
  {
    id: "T01-startClaudeSession",
    question: "Where is the Claude SDK session started?",
    acceptableFiles: ["apps/server/src/provider/drivers/claude.ts"],
    symbol: "startClaudeSession",
    grepPattern: "startClaudeSession",
  },
  {
    id: "T02-IndexService",
    question: "Where is the IndexService interface defined?",
    acceptableFiles: ["packages/index/src/api.ts"],
    symbol: "IndexService",
    grepPattern: "class IndexService",
  },
  {
    id: "T03-treesitterChunker",
    question: "Where is the tree-sitter chunker implemented?",
    acceptableFiles: ["packages/index/src/chunker/treesitter.ts"],
    symbol: "treesitterChunker",
    grepPattern: "treesitterChunker",
  },
  {
    id: "T04-PermissionService",
    question: "Where does the permission service live?",
    acceptableFiles: [
      "apps/server/src/provider/services/permission-service.ts",
      "apps/server/src/provider/layers/permission-service.ts",
    ],
    symbol: "PermissionService",
    grepPattern: "PermissionService",
  },
  {
    id: "T05-MemoizeRpcs",
    question: "Where is the RPC group built?",
    acceptableFiles: ["packages/contracts/src/rpc.ts"],
    symbol: "MemoizeRpcs",
    grepPattern: "MemoizeRpcs = RpcGroup",
  },
  {
    id: "T06-GitService",
    question: "Where is GitService implemented?",
    acceptableFiles: ["apps/server/src/git/layers/git-service.ts"],
    symbol: "GitService",
    grepPattern: "class GitService",
  },
  {
    id: "T07-buildIndexTools",
    question: "Where are Claude index tools defined?",
    acceptableFiles: ["apps/server/src/code-index/claude-tools.ts"],
    symbol: "buildIndexTools",
    grepPattern: "buildIndexTools",
  },
  {
    id: "T08-MigrationsLive",
    question: "Where does the migration runner live?",
    acceptableFiles: ["apps/server/src/persistence/migrations.ts"],
    symbol: "MigrationsLive",
    grepPattern: "MigrationsLive",
  },
  {
    id: "T09-PtyService",
    question: "Where is the PTY service layered?",
    acceptableFiles: ["apps/server/src/pty/layers/pty-service.ts"],
    symbol: "PtyServiceLive",
    grepPattern: "PtyServiceLive",
  },
  {
    id: "T10-AttachmentService",
    question: "Where is AttachmentService implemented?",
    acceptableFiles: [
      "apps/server/src/attachment/services/attachment-service.ts",
      "apps/server/src/attachment/layers/attachment-service.ts",
    ],
    symbol: "AttachmentService",
    grepPattern: "AttachmentService",
  },
  {
    id: "T11-indexRepo",
    question: "Where is the repo walker that builds the index?",
    acceptableFiles: ["packages/index/src/indexer.ts"],
    symbol: "indexRepo",
    grepPattern: "indexRepo",
  },
  {
    id: "T12-detectLanguage",
    question: "Where is file-language detection?",
    acceptableFiles: ["packages/index/src/chunker/language.ts"],
    symbol: "detectLanguage",
    grepPattern: "detectLanguage",
  },
  {
    id: "T13-blakeOf",
    question: "Where is content hashing implemented?",
    acceptableFiles: ["packages/index/src/blob/hash.ts"],
    symbol: "blakeOf",
    grepPattern: "blakeOf",
  },
  {
    id: "T14-setManifestBulk",
    question: "Where is the branch manifest updated in bulk?",
    acceptableFiles: ["packages/index/src/manifest/manifest.ts"],
    symbol: "setManifestBulk",
    grepPattern: "setManifestBulk",
  },
  {
    id: "T15-runMigrations",
    question: "Where does the index DB apply schema migrations?",
    acceptableFiles: ["packages/index/src/schema/migrations.ts"],
    symbol: "runMigrations",
    grepPattern: "runMigrations",
  },
  {
    id: "T16-walkRepo",
    question: "Where is the gitignore-respecting walker?",
    acceptableFiles: ["packages/index/src/walker.ts"],
    symbol: "walkRepo",
    grepPattern: "walkRepo",
  },
  {
    id: "T17-FolderPicker",
    question: "Where is FolderPicker tagged?",
    acceptableFiles: ["apps/server/src/workspace/services/folder-picker.ts"],
    symbol: "FolderPicker",
    grepPattern: "FolderPicker",
  },
  {
    id: "T18-PingRpc",
    question: "Where is the ping RPC declared?",
    acceptableFiles: ["packages/contracts/src/ping.ts"],
    symbol: "PingRpc",
    grepPattern: "PingRpc",
  },
  {
    id: "T19-makeMainLayer",
    question: "Where is the server's main layer factory?",
    acceptableFiles: ["apps/server/src/runtime.ts"],
    symbol: "makeMainLayer",
    grepPattern: "makeMainLayer",
  },
  {
    id: "T20-IndexRegistry",
    question: "Where is the per-workspace IndexRegistry?",
    acceptableFiles: [
      "apps/server/src/code-index/services/index-registry.ts",
      "apps/server/src/code-index/layers/index-registry.ts",
    ],
    symbol: "IndexRegistry",
    grepPattern: "IndexRegistry",
  },
];
