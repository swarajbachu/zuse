import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadListResponse } from "@zuse/agents/codex-generated/v2/ThreadListResponse";
import type { ThreadReadResponse } from "@zuse/agents/codex-generated/v2/ThreadReadResponse";
import type { UserInput } from "@zuse/agents/codex-generated/v2/UserInput";
import { translateClaudeSdkMessages } from "@zuse/agents/drivers/claude";
import { translateCodexItem } from "@zuse/agents/drivers/codex";
import { CodexAppServerClient } from "@zuse/agents/drivers/codex-app-server-client";
import {
  ContinueExternalThreadResult,
  defaultModelFor,
  ExternalThread,
  type Folder,
  type Message,
  type MessageContent,
  type ProviderId,
  type Worktree,
  WorktreeId,
} from "@zuse/contracts";
import { WorktreeService } from "@zuse/git/worktree-service";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner as CommandExecutor } from "effect/unstable/process";
import { SqlClient } from "effect/unstable/sql";
import { eventToContent } from "../../conversation/core/conversation-message-mapping.ts";
import { TranscriptService } from "../../conversation/services/conversation-services.ts";
import { resolveCliPath } from "../../provider/availability.ts";
import { WorkspaceService } from "../../workspace/services/workspace-service.ts";
import { ExternalThreadService } from "../services/external-thread-service.ts";

type DiscoveredThread = {
  readonly id: string;
  readonly providerId: "claude" | "codex";
  readonly title: string;
  readonly preview: string;
  readonly projectPath: string;
  readonly updatedAt: Date;
  readonly sourcePath: string | null;
  readonly cursor: string;
  readonly resumeStrategy: "claude-session-id" | "codex-thread-id";
};

const clamp = (value: string, max: number): string => {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

const firstString = (...values: ReadonlyArray<unknown>): string | null => {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
};

const contentText = (value: unknown): string | null => {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const text = value
      .flatMap((item) => {
        const record = asRecord(item);
        if (record === null) return [];
        const type = firstString(record["type"])?.toLowerCase() ?? "";
        if (type.length > 0 && type !== "text") return [];
        const text = firstString(record["text"]);
        return text === null ? [] : [text];
      })
      .join("\n")
      .trim();
    return text.length > 0 ? text : null;
  }
  const record = asRecord(value);
  if (record !== null) {
    return contentText(record["content"]) ?? firstString(record["text"]);
  }
  return null;
};

const rowMessage = (
  row: Record<string, unknown>,
): Record<string, unknown> | null => asRecord(row["message"]);

const rowRole = (row: Record<string, unknown>): string => {
  const message = rowMessage(row);
  return (
    firstString(row["role"], message?.["role"], row["type"])?.toLowerCase() ??
    ""
  );
};

const rowText = (row: Record<string, unknown>): string | null => {
  const message = rowMessage(row);
  return (
    contentText(message?.["content"]) ??
    contentText(row["content"]) ??
    firstString(row["text"])
  );
};

const isSystemLikeText = (text: string): boolean =>
  text.includes("<system_instruction>") ||
  text.includes("<task-notification>") ||
  text.startsWith("You are working inside ");

const isMeaningfulConversationText = (
  row: Record<string, unknown>,
  text: string,
): boolean => {
  const type = firstString(row["type"])?.toLowerCase() ?? "";
  const role = rowRole(row);
  return (
    !isSystemLikeText(text) &&
    type !== "queue-operation" &&
    type !== "attachment" &&
    type !== "last-prompt" &&
    (role === "user" || role === "assistant")
  );
};

const projectPathFromText = (text: string): string | null => {
  const match = text.match(
    /work should take place in the ([^\n]+?) directory/i,
  );
  return match?.[1]?.trim() ?? null;
};

const fallbackProjectPathFromClaudeDir = (dirName: string): string | null => {
  if (!dirName.startsWith("-")) return null;
  const decoded = `/${dirName.slice(1).replaceAll("-", "/")}`;
  return decoded.length > 1 ? decoded : null;
};

const parseJsonLines = (
  file: string,
): ReadonlyArray<Record<string, unknown>> => {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          const record = asRecord(parsed);
          return record === null ? [] : [record];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};

export const discoverClaudeThreads = (
  root = path.join(homedir(), ".claude", "projects"),
): ReadonlyArray<DiscoveredThread> => {
  if (!existsSync(root)) return [];
  const out: DiscoveredThread[] = [];
  for (const projectDir of readdirSync(root, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;
    const dirPath = path.join(root, projectDir.name);
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const sourcePath = path.join(dirPath, entry.name);
      const rows = parseJsonLines(sourcePath);
      if (rows.length === 0) continue;
      const stat = statSync(sourcePath);
      let sessionId = entry.name.replace(/\.jsonl$/, "");
      let title: string | null = null;
      let preview: string | null = null;
      let projectPath: string | null = null;
      let updatedAt = stat.mtime;

      for (const row of rows) {
        sessionId = firstString(row["sessionId"], sessionId) ?? sessionId;
        title = title ?? firstString(row["aiTitle"], row["summary"]);
        const timestamp = firstString(row["timestamp"], row["created_at"]);
        if (timestamp !== null) {
          const parsed = new Date(timestamp);
          if (!Number.isNaN(parsed.getTime()) && parsed > updatedAt) {
            updatedAt = parsed;
          }
        }
        const cwd = firstString(row["cwd"]);
        if (cwd !== null) projectPath = cwd;
        const content = rowText(row);
        if (content !== null) {
          projectPath = projectPath ?? projectPathFromText(content);
          if (preview === null && isMeaningfulConversationText(row, content)) {
            preview = content;
          }
        }
      }

      projectPath =
        projectPath ?? fallbackProjectPathFromClaudeDir(projectDir.name);
      if (projectPath === null) continue;
      const finalPreview = preview ?? title ?? "Claude Code conversation";
      out.push({
        id: `claude:${sessionId}`,
        providerId: "claude",
        title: clamp(title ?? finalPreview, 96),
        preview: clamp(finalPreview, 140),
        projectPath,
        updatedAt,
        sourcePath,
        cursor: sessionId,
        resumeStrategy: "claude-session-id",
      });
    }
  }
  return out;
};

const discoverCodexViaAppServer = (limit: number) =>
  Effect.gen(function* () {
    const codexPath = yield* resolveCliPath("codex");
    if (codexPath === null) return [] as ReadonlyArray<DiscoveredThread>;
    const app = yield* Effect.tryPromise({
      try: () =>
        CodexAppServerClient.start({
          codexPath,
          onNotification: () => {},
          onServerRequest: (_request, respond) => respond(null),
        }),
      catch: () => null,
    });
    if (app === null) return [] as ReadonlyArray<DiscoveredThread>;
    try {
      const response = yield* Effect.tryPromise({
        try: () =>
          app.request<ThreadListResponse>("thread/list", {
            limit,
            sortKey: "updated_at",
            sortDirection: "desc",
            archived: false,
          }),
        catch: () => null,
      });
      if (response === null) return [] as ReadonlyArray<DiscoveredThread>;
      return response.data
        .filter((thread) => thread.cwd.length > 0)
        .map(
          (thread): DiscoveredThread => ({
            id: `codex:${thread.id}`,
            providerId: "codex",
            title: clamp(
              thread.name ?? thread.preview ?? "Codex conversation",
              96,
            ),
            preview: clamp(
              thread.preview ?? thread.name ?? "Codex conversation",
              140,
            ),
            projectPath: thread.cwd,
            updatedAt: new Date(thread.updatedAt * 1000),
            sourcePath: thread.path,
            cursor: thread.id,
            resumeStrategy: "codex-thread-id",
          }),
        );
    } finally {
      app.close();
    }
  });

const discoverCodexFromIndex = (): ReadonlyArray<DiscoveredThread> => {
  const file = path.join(homedir(), ".codex", "session_index.jsonl");
  if (!existsSync(file)) return [];
  return parseJsonLines(file).flatMap(
    (row): ReadonlyArray<DiscoveredThread> => {
      const id = firstString(row["id"]);
      if (id === null) return [];
      const title = firstString(row["thread_name"]) ?? "Codex conversation";
      const updated = firstString(row["updated_at"]);
      const updatedAt =
        updated === null || Number.isNaN(new Date(updated).getTime())
          ? new Date(0)
          : new Date(updated);
      return [
        {
          id: `codex:${id}`,
          providerId: "codex",
          title: clamp(title, 96),
          preview: clamp(title, 140),
          projectPath: "",
          updatedAt,
          sourcePath: file,
          cursor: id,
          resumeStrategy: "codex-thread-id",
        },
      ];
    },
  );
};

export const claudeTranscriptMessages = (
  sourcePath: string | null | undefined,
): ReadonlyArray<MessageContent> => {
  if (sourcePath === null || sourcePath === undefined) return [];
  return parseJsonLines(sourcePath).flatMap(
    (row): ReadonlyArray<MessageContent> => {
      const message = rowMessage(row);
      const content = rowText(row);
      if (message !== null && rowRole(row) !== "user") {
        return translateClaudeSdkMessages([
          row as unknown as SDKMessage,
        ]).flatMap((event) => {
          const translated = eventToContent(event);
          return translated === null ? [] : [translated];
        });
      }
      if (
        message !== null &&
        rowRole(row) === "user" &&
        Array.isArray(message["content"]) &&
        message["content"].some(
          (block) => asRecord(block)?.["type"] === "tool_result",
        )
      ) {
        return translateClaudeSdkMessages([
          row as unknown as SDKMessage,
        ]).flatMap((event) => {
          const translated = eventToContent(event);
          return translated === null ? [] : [translated];
        });
      }
      if (content === null || !isMeaningfulConversationText(row, content)) {
        return [];
      }
      const role = rowRole(row);
      if (role === "user" || role === "human") {
        return [{ _tag: "user", text: content, goal: false }];
      }
      if (role === "assistant") {
        return [{ _tag: "assistant", text: content }];
      }
      return [];
    },
  );
};

const codexUserInputText = (input: UserInput): string | null => {
  switch (input.type) {
    case "text":
      return input.text.trim() || null;
    case "mention":
      return `@${input.name}`;
    case "skill":
      return `/${input.name}`;
    case "image":
      return `[image](${input.url})`;
    case "localImage":
      return `[image](${input.path})`;
  }
};

const codexTranscriptMessages = (cursor: string) =>
  Effect.gen(function* () {
    const codexPath = yield* resolveCliPath("codex");
    if (codexPath === null) return [];
    const app = yield* Effect.tryPromise({
      try: () =>
        CodexAppServerClient.start({
          codexPath,
          onNotification: () => {},
          onServerRequest: (_request, respond) => respond(null),
        }),
      catch: () => null,
    });
    if (app === null) return [];
    try {
      const response = yield* Effect.tryPromise({
        try: () =>
          app.request<ThreadReadResponse>("thread/read", {
            threadId: cursor,
            includeTurns: true,
          }),
        catch: () => null,
      });
      if (response === null) return [];
      const out: MessageContent[] = [];
      for (const turn of response.thread.turns) {
        for (const item of turn.items) {
          if (item.type === "userMessage") {
            const text = item.content
              .flatMap((input) => {
                const fragment = codexUserInputText(input);
                return fragment === null ? [] : [fragment];
              })
              .join("\n")
              .trim();
            if (text.length > 0) {
              out.push({ _tag: "user", text, goal: false });
            }
            continue;
          }
          for (const event of translateCodexItem(item, "completed")) {
            const content = eventToContent(event);
            if (content !== null) out.push(content);
          }
        }
        if (turn.status === "failed" && turn.error !== null) {
          out.push({
            _tag: "error",
            message: turn.error.message,
          });
        }
      }
      return out;
    } finally {
      app.close();
    }
  }).pipe(Effect.catch(() => Effect.succeed([])));

const toExternalThread = (thread: DiscoveredThread): ExternalThread =>
  ExternalThread.make({
    ...thread,
    projectName:
      thread.projectPath.length > 0
        ? path.basename(thread.projectPath)
        : "Unknown project",
    available: thread.projectPath.length > 0 && existsSync(thread.projectPath),
  });

const findOrAddProject = (
  workspace: WorkspaceService["Service"],
  worktrees: WorktreeService["Service"],
  sql: SqlClient.SqlClient,
  projectPath: string,
): Effect.Effect<
  {
    readonly project: Folder;
    readonly worktreeId: WorktreeId | null;
    readonly worktree: Worktree | null;
  },
  unknown
> =>
  Effect.gen(function* () {
    const resolved = path.resolve(projectPath);
    const folders = yield* workspace.list();
    for (const folder of folders) {
      const knownWorktrees = yield* worktrees.list(folder.id);
      const known = knownWorktrees.find(
        (wt) => path.resolve(wt.path) === resolved,
      );
      if (known !== undefined) {
        return { project: folder, worktreeId: known.id, worktree: known };
      }
    }

    const externalCommonDir = gitCommonDir(resolved);
    const externalGitDir = gitDir(resolved);
    const isLinkedWorktree =
      externalCommonDir !== null &&
      externalGitDir !== null &&
      externalCommonDir !== externalGitDir;
    if (externalCommonDir !== null && isLinkedWorktree) {
      for (const folder of folders) {
        const folderCommonDir = gitCommonDir(folder.path);
        if (
          folderCommonDir !== null &&
          folderCommonDir === externalCommonDir &&
          path.resolve(folder.path) !== resolved
        ) {
          const worktreeId = yield* registerExistingWorktree(
            sql,
            folder,
            resolved,
          );
          const worktree = yield* worktrees.get(worktreeId);
          return { project: folder, worktreeId, worktree };
        }
      }
    }

    const existing = folders.find((folder) => folder.path === resolved);
    if (existing !== undefined) {
      return { project: existing, worktreeId: null, worktree: null };
    }

    const project = yield* workspace.add(resolved);
    return { project, worktreeId: null, worktree: null };
  });

const gitOutput = (cwd: string, args: ReadonlyArray<string>): string | null => {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

const gitCommonDir = (cwd: string): string | null => {
  const out = gitOutput(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return out === null || out.length === 0 ? null : path.resolve(out);
};

const gitDir = (cwd: string): string | null => {
  const out = gitOutput(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
  ]);
  return out === null || out.length === 0 ? null : path.resolve(out);
};

const gitBranch = (cwd: string): string =>
  gitOutput(cwd, ["branch", "--show-current"]) ||
  gitOutput(cwd, ["rev-parse", "--short", "HEAD"]) ||
  "HEAD";

const registerExistingWorktree = (
  sql: SqlClient.SqlClient,
  project: Folder,
  worktreePath: string,
): Effect.Effect<WorktreeId> =>
  Effect.gen(function* () {
    const existing = yield* sql<{ readonly id: string }>`
      SELECT id FROM worktrees WHERE path = ${worktreePath} LIMIT 1
    `.pipe(Effect.orDie);
    if (existing.length > 0) return WorktreeId.make(existing[0]!.id);

    const id = WorktreeId.make(crypto.randomUUID());
    const name = path.basename(worktreePath) || gitBranch(worktreePath);
    const branch = gitBranch(worktreePath);
    const nowIso = new Date().toISOString();
    yield* sql`
      INSERT INTO worktrees
        (id, project_id, path, name, branch, base_branch, created_at,
         setup_status, setup_output)
      VALUES
        (${id}, ${project.id}, ${worktreePath}, ${name}, ${branch}, 'HEAD',
         ${nowIso}, 'skipped', '')
    `.pipe(Effect.orDie);
    return id;
  });

export const ExternalThreadServiceLive = Layer.effect(
  ExternalThreadService,
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.ChildProcessSpawner;
    const sql = yield* SqlClient.SqlClient;
    const workspace = yield* WorkspaceService;
    const worktrees = yield* WorktreeService;
    const messages = yield* TranscriptService;

    const list: ExternalThreadService["Service"]["list"] = (limit) =>
      Effect.gen(function* () {
        const codex = yield* discoverCodexViaAppServer(limit).pipe(
          Effect.provideService(CommandExecutor.ChildProcessSpawner, executor),
          Effect.catch(() => Effect.succeed(discoverCodexFromIndex())),
        );
        const codexRows = codex.length > 0 ? codex : discoverCodexFromIndex();
        const rows = [...discoverClaudeThreads(), ...codexRows]
          .map(toExternalThread)
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        return rows.slice(0, limit);
      });

    const continueThread: ExternalThreadService["Service"]["continueThread"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const providerId = input.providerId as ProviderId;
        const binding = yield* findOrAddProject(
          workspace,
          worktrees,
          sql,
          input.projectPath,
        ).pipe(Effect.orDie);
        const resumeStrategy =
          providerId === "claude" ? "claude-session-id" : "codex-thread-id";
        const title =
          input.title?.trim() ||
          `${providerId === "claude" ? "Claude" : "Codex"} thread`;
        const result = yield* messages
          .continueExternalThread({
            projectId: binding.project.id,
            worktreeId: binding.worktreeId,
            providerId,
            model: defaultModelFor(providerId),
            title,
            resumeCursor: input.cursor,
            resumeStrategy,
          })
          .pipe(Effect.orDie);
        let importedMessages: ReadonlyArray<Message> = [];
        if (providerId === "claude") {
          const imported = claudeTranscriptMessages(input.sourcePath);
          if (imported.length > 0) {
            importedMessages = yield* messages
              .importExternalMessages(result.initialSession.id, imported)
              .pipe(Effect.orDie);
          }
        } else if (providerId === "codex") {
          const imported = yield* codexTranscriptMessages(input.cursor).pipe(
            Effect.provideService(
              CommandExecutor.ChildProcessSpawner,
              executor,
            ),
          );
          if (imported.length > 0) {
            importedMessages = yield* messages
              .importExternalMessages(result.initialSession.id, imported)
              .pipe(Effect.orDie);
          }
        }
        return ContinueExternalThreadResult.make({
          project: binding.project,
          worktree: binding.worktree,
          chat: result.chat,
          session: result.initialSession,
          messages: importedMessages,
        });
      });

    return { list, continueThread } as const;
  }),
);
