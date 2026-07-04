import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { Effect, Mailbox, Stream } from "effect";

import {
  AgentSessionStartError,
  type AgentEvent,
  type AgentItemId,
  type AgentSessionId,
  type AttachmentRef,
  type PermissionMode,
  type StartSessionInput,
  type UserQuestionAnswer,
} from "@zuse/wire";

import { AttachmentService } from "../../attachment/services/attachment-service.ts";
import { createAcpTranslator } from "./acp/translate.ts";
import { applyPlanModePrefix } from "./planMode.ts";
import {
  finishCompactEvent,
  isCompactCommand,
  startCompactEvent,
  startCompactSnapshot,
} from "./compact.ts";
import { handleFsRequest } from "./acp/fs.ts";
import { handleTerminalRequest } from "./acp/terminal.ts";
import type { GetRuntimeMode, RequestPermission } from "./claude.ts";

/**
 * Live-only handle for one Gemini conversation. Mirrors the Grok/Codex/Claude
 * handle shape so `ProviderService` routes RPCs without caring which provider
 * backs the session.
 *
 * Google's `@google/gemini-cli` exposes an ACP server via
 * `gemini --experimental-acp` — the exact same JSON-RPC protocol Grok uses.
 * One persistent child per session (Claude-style), not one spawn per turn
 * (Codex-style). The conversation is identified by an ACP-minted `sessionId`
 * returned from `session/new`; we surface that as a
 * `SessionCursor { strategy: "grok-session-id" }` (intentional shared label —
 * the persistence shape is identical to Grok's; renaming the literal would
 * be a migration of its own).
 */
export interface GeminiSessionHandle {
  readonly events: Stream.Stream<AgentEvent>;
  readonly send: (
    text: string,
    attachments?: ReadonlyArray<AttachmentRef>,
  ) => Effect.Effect<void>;
  readonly interrupt: () => Effect.Effect<void>;
  readonly close: () => Effect.Effect<void>;
  /**
   * Cached locally and passed as `_meta.permissionMode` on the next
   * `session/prompt`. ACP doesn't yet document a live mode-switch method,
   * so this is best-effort — the server may ignore it. We always emit
   * `PermissionModeChanged` so the renderer chip stays in sync.
   */
  readonly setPermissionMode: (mode: PermissionMode) => Effect.Effect<void>;
  /**
   * No ACP `UserQuestion` primitive yet — match Grok and stay a no-op so
   * RPC routing remains uniform.
   */
  readonly answerQuestion: (
    itemId: AgentItemId,
    answers: ReadonlyArray<UserQuestionAnswer>,
  ) => Effect.Effect<void>;
}

interface JsonRpcError {
  readonly code?: number;
  readonly message?: string;
  readonly data?: unknown;
}

interface JsonRpcMessage {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: { update?: unknown };
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

type PendingResolver = {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

const GEMINI_RPC_TRACE = process.env.MEMOIZE_DEBUG_GEMINI === "1";

const formatGeminiDiagnostics = (diagnostics: string): string => {
  const trimmed = diagnostics.trim();
  if (trimmed.length === 0) return trimmed;
  if (
    /Unknown arguments?:.*(?:experimental-acp|experimentalAcp|acp)/is.test(
      trimmed,
    )
  ) {
    return [
      "Installed Gemini CLI does not support ACP mode (`gemini --experimental-acp`).",
      "Upgrade Gemini CLI with `npm i -g @google/gemini-cli@latest`, then restart Zuse.",
    ].join("\n");
  }
  return trimmed;
};

const formatRpcError = (
  err: JsonRpcError,
  diagnosticTail: string,
  rawEnvelope?: string,
): string => {
  const parts: string[] = [];
  if (typeof err.message === "string" && err.message.length > 0) {
    parts.push(err.message);
  }
  if (err.data !== undefined && err.data !== null) {
    if (typeof err.data === "string") {
      parts.push(err.data);
    } else if (typeof err.data === "object") {
      const d = err.data as Record<string, unknown>;
      const detail =
        typeof d["message"] === "string"
          ? (d["message"] as string)
          : typeof d["error"] === "string"
            ? (d["error"] as string)
            : typeof d["details"] === "string"
              ? (d["details"] as string)
              : typeof d["reason"] === "string"
                ? (d["reason"] as string)
                : null;
      if (detail !== null && detail.length > 0) {
        parts.push(detail);
      } else {
        try {
          const serialized = JSON.stringify(err.data);
          if (serialized !== "{}" && serialized.length > 0)
            parts.push(serialized);
        } catch {
          // unserialisable — fall through
        }
      }
    }
  }
  if (parts.length === 0) {
    const trimmedDiagnostics = formatGeminiDiagnostics(diagnosticTail);
    if (trimmedDiagnostics.length > 0) parts.push(trimmedDiagnostics);
    else parts.push("Gemini ACP returned an error with no detail.");
  }
  if (typeof err.code === "number") parts.push(`(code ${err.code})`);
  const trimmedDiagnostics = formatGeminiDiagnostics(diagnosticTail);
  if (
    trimmedDiagnostics.length > 0 &&
    parts.every((p) => p !== trimmedDiagnostics)
  ) {
    parts.push(`Diagnostics:\n${trimmedDiagnostics}`);
  }
  if (rawEnvelope !== undefined && rawEnvelope.length > 0) {
    parts.push(`Raw JSON-RPC error:\n${rawEnvelope}`);
  }
  return parts.join(" — ");
};

/**
 * Add `cwd` to `~/.gemini/trustedFolders.json` so the CLI's folder-trust
 * check passes. Without this, Gemini logs `Skipping project agents due to
 * untrusted folder` and disables project hooks / project agents / ripgrep.
 *
 * File format: `{ "<absolute-path>": "TRUST_FOLDER" }` (per the official
 * gemini-cli docs, docs/cli/trusted-folders.md). We always merge — never
 * overwrite — because the user may have trusted other folders manually.
 *
 * Best-effort: if any fs op fails the CLI just stays in safe mode, so we
 * swallow errors via `Effect.ignore`.
 */
const ensureGeminiFolderTrusted = (cwd: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const home = os.homedir();
    if (home.length === 0) return;
    const geminiDir = path.join(home, ".gemini");
    const trustedFile = path.join(geminiDir, "trustedFolders.json");
    const absCwd = path.resolve(cwd);

    const current = yield* Effect.tryPromise(() =>
      fs.promises.readFile(trustedFile, "utf-8"),
    ).pipe(
      Effect.flatMap((raw) =>
        Effect.try(() => {
          const parsed: unknown = JSON.parse(raw);
          if (
            parsed === null ||
            typeof parsed !== "object" ||
            Array.isArray(parsed)
          ) {
            return {} as Record<string, string>;
          }
          return parsed as Record<string, string>;
        }),
      ),
      Effect.catchAll(() => Effect.succeed({} as Record<string, string>)),
    );

    if (current[absCwd] === "TRUST_FOLDER") return;

    const next = { ...current, [absCwd]: "TRUST_FOLDER" };

    yield* Effect.tryPromise(() =>
      fs.promises.mkdir(geminiDir, { recursive: true, mode: 0o700 }),
    ).pipe(Effect.ignore);

    yield* Effect.tryPromise(() =>
      fs.promises.writeFile(trustedFile, JSON.stringify(next, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      }),
    ).pipe(Effect.ignore);

    yield* Effect.logInfo(`gemini: trusted folder ${absCwd}`);
  });

/**
 * Spin up a Gemini conversation backed by a persistent ACP child process.
 * The handshake (`initialize` → `authenticate` → `session/new`) runs once
 * synchronously inside `start()`; auth or transport failures surface there
 * so the orchestrator can fail the session-create RPC cleanly.
 *
 * `apiKey` is forwarded as `GEMINI_API_KEY` on the child env. When null,
 * the CLI falls back to cached OAuth credentials under `~/.gemini/` (run
 * `gemini` interactively to sign in). We prefer the API-key auth method
 * when a key is set; otherwise `oauth-personal` / `cached_token`.
 */
export const startGeminiSession = (
  input: StartSessionInput,
  cwd: string,
  apiKey: string | null,
  geminiPath: string,
  sessionId: AgentSessionId,
  requestPermission: RequestPermission,
  getRuntimeMode: GetRuntimeMode,
  resumeCursor: string | null = null,
): Effect.Effect<
  GeminiSessionHandle,
  AgentSessionStartError,
  AttachmentService
> =>
  Effect.gen(function* () {
    // Keep AttachmentService in the requirement set so layer wiring stays
    // uniform with the other drivers; attachments themselves are not yet
    // wired through ACP's `prompt: [{ type: "image", ... }]` shape.
    yield* AttachmentService;
    const events = yield* Mailbox.make<AgentEvent>();

    let currentMode: PermissionMode = input.permissionMode ?? "default";

    // Shared context for the ACP fs/* and terminal/* handlers so file writes
    // and command execution are gated through PermissionService + RuntimeMode,
    // exactly like Claude/Codex. `currentMode` is read live.
    const acpHandlerContext = () => ({
      cwd,
      sessionId,
      projectId: input.folderId,
      requestPermission: (
        kind: import("@zuse/wire").PermissionKind,
        options: { readonly forcePrompt: boolean },
      ) => requestPermission(sessionId, kind, options),
      getRuntimeMode,
      getPermissionMode: () => currentMode,
    });

    let acpSessionId: string | null = null;
    let nextRpcId = 1;
    let closed = false;
    let inflight: Promise<void> = Promise.resolve();
    const pending = new Map<number, PendingResolver>();
    let stderrTail = "";
    let stdoutNoiseTail = "";

    const diagnosticTail = (): string => {
      const parts: string[] = [];
      const trimmedStderr = stderrTail.trim();
      const trimmedStdout = stdoutNoiseTail.trim();
      if (trimmedStderr.length > 0) parts.push(`stderr:\n${trimmedStderr}`);
      if (trimmedStdout.length > 0) {
        parts.push(`non-JSON stdout:\n${trimmedStdout}`);
      }
      return parts.join("\n\n");
    };

    events.unsafeOffer({
      _tag: "Started",
      sessionId,
      providerId: "gemini",
      mode: "sdk",
    });

    yield* ensureGeminiFolderTrusted(cwd);

    // Per-session translator coalesces agent_message_chunk deltas into
    // one AssistantMessage per burst so the renderer doesn't show one
    // bubble per token.
    const translator = createAcpTranslator("gemini");

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(geminiPath, ["--experimental-acp"], {
        cwd,
        env: {
          ...process.env,
          ...(apiKey !== null ? { GEMINI_API_KEY: apiKey } : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (cause) {
      yield* events.end;
      return yield* Effect.fail(
        new AgentSessionStartError({
          providerId: "gemini",
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    const rl = readline.createInterface({ input: child.stdout });

    const writeMessage = (msg: Record<string, unknown>): void => {
      if (!child.stdin.writable) return;
      const line = JSON.stringify(msg);
      if (GEMINI_RPC_TRACE) process.stderr.write(`[gemini.rpc.send] ${line}\n`);
      child.stdin.write(`${line}\n`);
    };

    const request = (
      method: string,
      params: unknown,
      timeoutMs = 30_000,
      onAssignedId?: (id: number) => void,
    ): Promise<unknown> => {
      const id = nextRpcId++;
      onAssignedId?.(id);
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          const diagnostics = formatGeminiDiagnostics(diagnosticTail());
          const detail = diagnostics.length > 0 ? ` — ${diagnostics}` : "";
          reject(
            new Error(
              `Gemini ACP ${method} timed out after ${timeoutMs}ms${detail}`,
            ),
          );
        }, timeoutMs);
        pending.set(id, { method, resolve, reject, timer });
        writeMessage({ jsonrpc: "2.0", id, method, params });
      });
    };

    const notify = (method: string, params: unknown): void => {
      writeMessage({ jsonrpc: "2.0", method, params });
    };

    /**
     * Currently in-flight `session/prompt` rpc id. We track this so
     * `interrupt()` can both (a) send `session/cancel` to the agent AND
     * (b) force-reject the pending request, which unblocks the `inflight`
     * promise chain so subsequent `send()` calls don't queue behind a
     * dead request.
     */
    let currentPromptRpcId: number | null = null;
    const rejectCurrentPrompt = (reason: string): void => {
      const id = currentPromptRpcId;
      if (id === null) return;
      const resolver = pending.get(id);
      if (resolver === undefined) return;
      pending.delete(id);
      clearTimeout(resolver.timer);
      currentPromptRpcId = null;
      if (GEMINI_RPC_TRACE) {
        process.stderr.write(
          `[gemini.rpc.cancel] force-reject id=${id} method=${resolver.method} reason=${reason}\n`,
        );
      }
      resolver.reject(new Error(reason));
    };

    rl.on("line", (line: string) => {
      if (line.trim().length === 0) return;
      if (GEMINI_RPC_TRACE) process.stderr.write(`[gemini.rpc.recv] ${line}\n`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Known issue: Gemini CLI sometimes emits plain text to stdout
        // alongside the JSON-RPC stream (google-gemini/gemini-cli#22647).
        // Log to stderr so the leak is visible during debugging, but don't
        // abort — assistant content rides typed `session/update` frames.
        stdoutNoiseTail = (stdoutNoiseTail + `${line}\n`).slice(-4096);
        process.stderr.write(`[gemini.stdout.nonjson] ${line}\n`);
        return;
      }
      if (parsed === null || typeof parsed !== "object") return;
      const msg = parsed as JsonRpcMessage;

      if (typeof msg.method === "string") {
        if (msg.method === "session/update") {
          const update = msg.params?.update;
          if (update !== undefined) {
            for (const ev of translator.translate(update)) {
              events.unsafeOffer(ev);
            }
          }
          return;
        }

        // Forward item/* and thread/* notifications (collab swarming, per-thread
        // lifecycle) to the shared translator. Mirrors the Grok driver change.
        if (
          msg.method.startsWith("item/") ||
          msg.method.startsWith("thread/")
        ) {
          if (GEMINI_RPC_TRACE) {
            process.stderr.write(
              `[gemini.rpc] ${msg.method} params=${JSON.stringify(msg.params ?? {})}\n`,
            );
          }
          if (msg.params !== undefined) {
            for (const ev of translator.translate(msg.params)) {
              events.unsafeOffer(ev);
            }
          }
          return;
        }

        if (msg.id !== undefined) {
          const isFs = msg.method.startsWith("fs/");
          if (GEMINI_RPC_TRACE || isFs) {
            process.stderr.write(
              `[gemini.rpc] server→client request method=${msg.method} id=${msg.id} params=${JSON.stringify(msg.params ?? {})}\n`,
            );
          }
          if (isFs) {
            handleFsRequest(msg.method, msg.params, acpHandlerContext())
              .then((result) => {
                writeMessage({ jsonrpc: "2.0", id: msg.id, result });
              })
              .catch((err) => {
                const message =
                  err instanceof Error ? err.message : String(err);
                writeMessage({
                  jsonrpc: "2.0",
                  id: msg.id,
                  error: { code: -32603, message },
                });
              });
            return;
          }

          if (msg.method.startsWith("terminal/")) {
            handleTerminalRequest(msg.method, msg.params, acpHandlerContext())
              .then((result) => {
                writeMessage({ jsonrpc: "2.0", id: msg.id, result });
              })
              .catch((err) => {
                const message =
                  err instanceof Error ? err.message : String(err);
                writeMessage({
                  jsonrpc: "2.0",
                  id: msg.id,
                  error: { code: -32603, message },
                });
              });
            return;
          }

          // User question support for Gemini ACP (similar namespaced methods).
          const isQuestionMethod =
            msg.method?.includes("ask_user_question") ||
            msg.method?.includes("user_question") ||
            msg.method?.startsWith("_x.ai/") ||
            msg.method?.startsWith("_google/");

          if (isQuestionMethod) {
            if (process.env.MEMOIZE_DEBUG_GEMINI) {
              process.stderr.write(
                `[gemini.rpc] auto-acking question method=${msg.method} id=${msg.id} params=${JSON.stringify(msg.params ?? {})}\n`,
              );
            }
            // Gemini ACP may use a similar shape; provide `outcome` to avoid
            // "missing field `outcome`" errors on the agent side.
            writeMessage({
              jsonrpc: "2.0",
              id: msg.id,
              result: { outcome: "approved" },
            });
            return;
          }

          writeMessage({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32601,
              message: `Method not supported by Zuse ACP client: ${msg.method}`,
            },
          });
          console.warn(
            `[gemini.rpc] replied to unhandled server→client request method=${msg.method} id=${msg.id}`,
          );
          return;
        }
        return;
      }

      const id = typeof msg.id === "number" ? msg.id : null;
      if (id === null) return;
      const resolver = pending.get(id);
      if (resolver === undefined) return;
      pending.delete(id);
      clearTimeout(resolver.timer);
      if (msg.error !== undefined) {
        let rawEnvelope = "";
        try {
          rawEnvelope = JSON.stringify(msg.error, null, 2);
          process.stderr.write(
            `[gemini.rpc.error] method=${resolver.method} id=${id} ${rawEnvelope}\n`,
          );
        } catch {
          process.stderr.write(
            `[gemini.rpc.error] method=${resolver.method} id=${id} (unserialisable)\n`,
          );
        }
        const detail = formatRpcError(msg.error, diagnosticTail(), rawEnvelope);
        resolver.reject(
          new Error(`Gemini ${resolver.method} failed: ${detail}`),
        );
      } else {
        resolver.resolve(msg.result ?? {});
      }
    });

    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4096);
      process.stderr.write(`[gemini.stderr] ${chunk}`);
    });

    child.on("error", (err) => {
      if (closed) return;
      events.unsafeOffer({ _tag: "Error", message: err.message });
      void Effect.runPromise(events.end).catch(() => {});
    });

    child.on("close", (code, signal) => {
      rl.close();
      const diagnostics = formatGeminiDiagnostics(diagnosticTail());
      const exitDetail =
        diagnostics.length > 0
          ? `Gemini ACP exited (code ${code ?? "null"}, signal ${signal ?? "null"}): ${diagnostics}`
          : `Gemini ACP exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}).`;
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer);
        reject(new Error(exitDetail));
      }
      pending.clear();
      if (!closed) {
        events.unsafeOffer({ _tag: "Error", message: exitDetail });
        events.unsafeOffer({ _tag: "Status", status: "idle" });
      }
      void Effect.runPromise(events.end).catch(() => {});
    });

    // === ACP handshake — synchronous, fails the start() RPC on error. ===
    const handshake = Effect.tryPromise({
      try: async () => {
        const init = (await request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: {
              readTextFile: true,
              writeTextFile: true,
              readDirectory: true,
              createDirectory: true,
              deleteFile: true,
              moveFile: true,
            },
            terminal: true,
            // Opt into experimental (collab/swarming) so future Gemini ACP
            // agents can emit the same collabAgentToolCall data.
            experimentalApi: true,
          },
        })) as { authMethods?: ReadonlyArray<{ id?: unknown }> };

        const authIds = new Set(
          (init.authMethods ?? [])
            .map((m) => (typeof m?.id === "string" ? m.id : null))
            .filter((id): id is string => id !== null),
        );
        const methodId =
          apiKey !== null && authIds.has("gemini-api-key")
            ? "gemini-api-key"
            : authIds.has("oauth-personal")
              ? "oauth-personal"
              : authIds.has("cached_token")
                ? "cached_token"
                : null;
        if (methodId === null) {
          throw new Error(
            "Gemini ACP offered no usable auth method. Run `gemini` to sign in, or save a Gemini API key.",
          );
        }
        await request("authenticate", {
          methodId,
          _meta:
            methodId === "gemini-api-key" && apiKey !== null
              ? { "api-key": apiKey, headless: true }
              : { headless: true },
        });

        const sessionResult = (await request("session/new", {
          cwd,
          mcpServers: [],
        })) as { sessionId?: unknown };

        if (typeof sessionResult.sessionId !== "string") {
          throw new Error("Gemini ACP session/new returned no sessionId.");
        }
        return sessionResult.sessionId;
      },
      catch: (cause) =>
        new AgentSessionStartError({
          providerId: "gemini",
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    });

    acpSessionId = yield* handshake.pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          child.kill("SIGTERM");
        }),
      ),
    );

    events.unsafeOffer({
      _tag: "SessionCursor",
      cursor: acpSessionId,
      strategy: "grok-session-id",
    });

    if (resumeCursor !== null && resumeCursor !== acpSessionId) {
      console.warn(
        `[gemini] previous cursor ${resumeCursor} discarded — ACP session/load not wired; using new session ${acpSessionId}`,
      );
    }

    const enqueuePrompt = (text: string): void => {
      const sid = acpSessionId;
      if (sid === null) return;
      const compactSnapshot = isCompactCommand(text)
        ? startCompactSnapshot(null)
        : null;
      if (compactSnapshot !== null) {
        events.unsafeOffer(
          startCompactEvent({
            providerId: "gemini",
            snapshot: compactSnapshot,
          }),
        );
      }
      // Plan-mode emulation: gemini ACP has no native read-only switch, so
      // prepend a developer-instructions block while plan mode is active.
      const promptText =
        compactSnapshot !== null
          ? text.trim()
          : applyPlanModePrefix(currentMode, text);
      inflight = inflight
        .then(async () => {
          if (closed) return;
          if (GEMINI_RPC_TRACE) {
            process.stderr.write(
              `[gemini.prompt] enqueue len=${promptText.length} mode=${currentMode}\n`,
            );
          }
          try {
            await request(
              "session/prompt",
              {
                sessionId: sid,
                prompt: [{ type: "text", text: promptText }],
                _meta: {
                  permissionMode: currentMode,
                  ...(input.model !== undefined ? { model: input.model } : {}),
                },
              },
              5 * 60_000,
              (id) => {
                currentPromptRpcId = id;
              },
            );
            if (GEMINI_RPC_TRACE) {
              process.stderr.write(`[gemini.prompt] completed\n`);
            }
            if (compactSnapshot !== null && !closed) {
              events.unsafeOffer(
                finishCompactEvent({
                  itemId: compactSnapshot.itemId,
                  providerId: "gemini",
                  snapshot: compactSnapshot,
                  afterTokens: null,
                }),
              );
            }
          } catch (cause) {
            const reason =
              cause instanceof Error ? cause.message : String(cause);
            if (GEMINI_RPC_TRACE) {
              process.stderr.write(`[gemini.prompt] failed: ${reason}\n`);
            }
            // Cancellation is a clean stop, not an error condition — the
            // user already knows they interrupted. Surface other failures
            // (timeouts, transport errors, server-side rejections) so the
            // chat bubble shows them.
            const isCancellation = /cancel|interrupt/i.test(reason);
            if (!closed && !isCancellation) {
              events.unsafeOffer({
                _tag: "Error",
                message: reason,
              });
            }
          } finally {
            currentPromptRpcId = null;
            // Drain any buffered assistant text from the translator so the
            // final delta lands as a normal AssistantMessage instead of
            // sitting unobserved in memory.
            if (!closed) {
              for (const ev of translator.flush()) events.unsafeOffer(ev);
              events.unsafeOffer({ _tag: "Status", status: "idle" });
            }
          }
        })
        .catch(() => undefined);
    };

    if (input.initialPrompt !== undefined && input.initialPrompt.length > 0) {
      enqueuePrompt(input.initialPrompt);
    }

    const handle: GeminiSessionHandle = {
      events: Mailbox.toStream(events),
      send: (text, attachmentRefs) =>
        Effect.sync(() => {
          if (attachmentRefs !== undefined && attachmentRefs.length > 0) {
            console.warn(
              `[gemini.attach] dropping ${attachmentRefs.length} attachment(s) — ACP image content shape not wired`,
            );
          }
          enqueuePrompt(text);
        }),
      interrupt: () =>
        Effect.sync(() => {
          const sid = acpSessionId;
          if (sid === null) return;
          if (GEMINI_RPC_TRACE) {
            process.stderr.write(
              `[gemini.interrupt] sid=${sid} pendingPrompt=${currentPromptRpcId ?? "(none)"}\n`,
            );
          }
          // Best-effort cancel; do NOT SIGINT the child or the persistent
          // session dies for every subsequent send.
          notify("session/cancel", { sessionId: sid });
          // Force-reject the in-flight `session/prompt` request so the
          // `inflight` promise chain unblocks. Without this, if Gemini's
          // CLI doesn't honour `session/cancel` (or responds slowly), the
          // user's next message queues behind a dead request and the
          // session feels stuck.
          rejectCurrentPrompt("Interrupted by user");
        }),
      close: () =>
        Effect.gen(function* () {
          closed = true;
          for (const { reject, timer } of pending.values()) {
            clearTimeout(timer);
            reject(new Error("Gemini session closed"));
          }
          pending.clear();
          try {
            child.stdin.end();
          } catch {
            // ignore — stdin may already be closed by the child
          }
          child.kill("SIGTERM");
          rl.close();
          yield* events.end;
        }),
      setPermissionMode: (mode) =>
        Effect.sync(() => {
          if (mode === currentMode) return;
          currentMode = mode;
          events.unsafeOffer({ _tag: "PermissionModeChanged", mode });
        }),
      answerQuestion: () => Effect.void,
    };
    return handle;
  });
