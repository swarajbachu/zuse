import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { decodeJsonRpcLine } from "@zuse/acp/protocol";
import { AcpRpcClient } from "@zuse/acp/rpc-client";
import {
	type AgentEvent,
	type AgentItemId,
	type AgentSessionId,
	AgentSessionStartError,
	type AttachmentRef,
	type PermissionMode,
	type StartSessionInput,
	type UserQuestionAnswer,
} from "@zuse/contracts";
import { type Cause, Effect, Queue, Stream } from "effect";
import { ACP_CLIENT_CAPABILITIES } from "../kernel/acp-capabilities.ts";
import { formatAcpError } from "../kernel/acp-error.ts";
import { makeAcpPermissionContext } from "../kernel/acp-permission-context.ts";
import { createAcpSession } from "../kernel/acp-session.ts";
import { AttachmentService } from "../kernel/attachment-service.ts";
import type { ProviderSessionHandle } from "../kernel/driver.ts";
import { issueProviderMcpSession } from "../kernel/provider-mcp-session.ts";
import { makeStdioMcpFallback } from "../kernel/stdio-mcp-fallback.ts";
import { prefixFirstPromptWithWorkspaceInstructions } from "../kernel/workspace-instructions.ts";
import { handleFsRequest } from "./acp/fs.ts";
import { replyToAcpRequest } from "./acp/request-reply.ts";
import { handleTerminalRequest } from "./acp/terminal.ts";
import { createAcpTranslator } from "./acp/translate.ts";
import { browserMcpPromptHint } from "./browser-mcp-tools.ts";
import type { BrowserSend } from "./browser-tools.ts";
import type { GetRuntimeMode, RequestPermission } from "./claude.ts";
import {
	finishCompactEvent,
	isCompactCommand,
	startCompactEvent,
	startCompactSnapshot,
} from "./compact.ts";
import {
	type OrchestrationSessionTools,
	orchestrationMcpPromptHint,
} from "./orchestration-tools.ts";
import { applyPlanModePrefix } from "./planMode.ts";

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
export interface GeminiSessionHandle extends ProviderSessionHandle {
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
			Effect.catch(() => Effect.succeed({} as Record<string, string>)),
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
	browserSend: BrowserSend,
	browserMcpCommand: string,
	orchestrationTools: OrchestrationSessionTools | null = null,
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
		const events = yield* Queue.make<AgentEvent, Cause.Done>();

		let currentMode: PermissionMode = input.permissionMode ?? "default";

		// Shared context for the ACP fs/* and terminal/* handlers so file writes
		// and command execution are gated through PermissionService + RuntimeMode,
		// exactly like Claude/Codex. `currentMode` is read live.
		const acpHandlerContext = makeAcpPermissionContext({
			cwd,
			sessionId,
			projectId: input.folderId,
			requestPermission: (kind, options) =>
				requestPermission(sessionId, kind, options),
			getRuntimeMode,
			getPermissionMode: () => currentMode,
		});

		const mcpGatewaySession = yield* issueProviderMcpSession({
			providerId: "gemini",
			sessionId,
			browserSend,
			requestPermission: (kind, options) =>
				requestPermission(sessionId, kind, options),
			getRuntimeMode,
			getPermissionMode: () => currentMode,
			orchestrationTools,
		});

		const stdioMcpFallback = makeStdioMcpFallback({
			browserSend,
			command: browserMcpCommand,
			requestPermission: (kind, options) =>
				requestPermission(sessionId, kind, options),
			getRuntimeMode,
			getPermissionMode: () => currentMode,
			orchestrationTools,
		});

		let acpSessionId: string | null = null;
		let closed = false;
		let inflight: Promise<void> = Promise.resolve();
		let workspaceInstructionsPending = input.workspaceInstructions;
		let stderrTail = "";
		let stdoutNoiseTail = "";
		let mcpHintPending = true;

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

		Queue.offerUnsafe(events, {
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
			yield* Queue.end(events);
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

		const rpc = new AcpRpcClient(writeMessage);
		const request = (
			method: string,
			params: unknown,
			timeoutMs = 30_000,
			onAssignedId?: (id: number) => void,
		): Promise<unknown> =>
			rpc.request(method, params, {
				timeoutMs,
				onAssignedId,
				timeoutError: () => {
					const diagnostics = formatGeminiDiagnostics(diagnosticTail());
					const detail = diagnostics.length > 0 ? ` — ${diagnostics}` : "";
					return new Error(
						`Gemini ACP ${method} timed out after ${timeoutMs}ms${detail}`,
					);
				},
			});

		const notify = (method: string, params: unknown): void => {
			rpc.notify(method, params);
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
			const cancelled = rpc.cancel(id, new Error(reason));
			if (cancelled === null) return;
			currentPromptRpcId = null;
			if (GEMINI_RPC_TRACE) {
				process.stderr.write(
					`[gemini.rpc.cancel] force-reject id=${id} method=${cancelled.method} reason=${reason}\n`,
				);
			}
		};

		rl.on("line", (line: string) => {
			if (line.trim().length === 0) return;
			if (GEMINI_RPC_TRACE) process.stderr.write(`[gemini.rpc.recv] ${line}\n`);
			const msg = decodeJsonRpcLine(line);
			if (msg === null) {
				// Known issue: Gemini CLI sometimes emits plain text to stdout
				// alongside the JSON-RPC stream (google-gemini/gemini-cli#22647).
				// Log to stderr so the leak is visible during debugging, but don't
				// abort — assistant content rides typed `session/update` frames.
				stdoutNoiseTail = `${stdoutNoiseTail}${line}\n`.slice(-4096);
				process.stderr.write(`[gemini.stdout.nonjson] ${line}\n`);
				return;
			}

			if (typeof msg.method === "string") {
				if (msg.method === "session/update") {
					const update =
						msg.params !== null && typeof msg.params === "object"
							? (msg.params as Record<string, unknown>).update
							: undefined;
					if (update !== undefined) {
						for (const ev of translator.translate(update)) {
							Queue.offerUnsafe(events, ev);
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
							Queue.offerUnsafe(events, ev);
						}
					}
					return;
				}

				if (msg.id !== undefined && msg.id !== null) {
					const isFs = msg.method.startsWith("fs/");
					if (GEMINI_RPC_TRACE || isFs) {
						process.stderr.write(
							`[gemini.rpc] server→client request method=${msg.method} id=${msg.id} params=${JSON.stringify(msg.params ?? {})}\n`,
						);
					}
					if (isFs) {
						replyToAcpRequest(
							(message) => rpc.send(message),
							msg.id,
							handleFsRequest(msg.method, msg.params, acpHandlerContext()),
						);
						return;
					}

					if (msg.method.startsWith("terminal/")) {
						replyToAcpRequest(
							(message) => rpc.send(message),
							msg.id,
							handleTerminalRequest(
								msg.method,
								msg.params,
								acpHandlerContext(),
							),
						);
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

			rpc.acceptResponse(msg, {
				mapError: (error, context) => {
					let rawEnvelope = "";
					try {
						rawEnvelope = JSON.stringify(error, null, 2);
						process.stderr.write(
							`[gemini.rpc.error] method=${context.method} id=${context.id} ${rawEnvelope}\n`,
						);
					} catch {
						process.stderr.write(
							`[gemini.rpc.error] method=${context.method} id=${context.id} (unserialisable)\n`,
						);
					}
					const detail = formatAcpError(error, {
						fallback: "Gemini ACP returned an error with no detail.",
						diagnostics: formatGeminiDiagnostics(diagnosticTail()),
						appendDiagnostics: true,
						rawEnvelope,
					});
					return new Error(`Gemini ${context.method} failed: ${detail}`);
				},
			});
		});

		child.stderr.on("data", (chunk: string) => {
			stderrTail = (stderrTail + chunk).slice(-4096);
			process.stderr.write(`[gemini.stderr] ${chunk}`);
		});

		child.on("error", (err) => {
			if (closed) return;
			Queue.offerUnsafe(events, { _tag: "Error", message: err.message });
			Queue.endUnsafe(events);
		});

		child.on("close", (code, signal) => {
			rl.close();
			const diagnostics = formatGeminiDiagnostics(diagnosticTail());
			const exitDetail =
				diagnostics.length > 0
					? `Gemini ACP exited (code ${code ?? "null"}, signal ${signal ?? "null"}): ${diagnostics}`
					: `Gemini ACP exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}).`;
			rpc.rejectAll(new Error(exitDetail));
			if (!closed) {
				Queue.offerUnsafe(events, { _tag: "Error", message: exitDetail });
				Queue.offerUnsafe(events, { _tag: "Status", status: "idle" });
			}
			Queue.endUnsafe(events);
		});

		// === ACP handshake — synchronous, fails the start() RPC on error. ===
		const handshake = Effect.tryPromise({
			try: async () => {
				const init = (await request("initialize", {
					protocolVersion: 1,
					clientCapabilities: ACP_CLIENT_CAPABILITIES,
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

				const httpMcpServers = [
					mcpGatewaySession.httpServerConfigs.browser,
					...(orchestrationTools === null
						? []
						: [mcpGatewaySession.httpServerConfigs.orchestration]),
					...(orchestrationTools?.linearTools === undefined
						? []
						: [mcpGatewaySession.httpServerConfigs.linear]),
				];
				return createAcpSession({
					request,
					cwd,
					sessionId,
					providerLabel: "Gemini",
					httpServers: httpMcpServers,
					fallbackServers: stdioMcpFallback.ensure,
					resumeCursor,
				});
			},
			catch: (cause) =>
				new AgentSessionStartError({
					providerId: "gemini",
					reason: cause instanceof Error ? cause.message : String(cause),
				}),
		});

		const acquiredSession = yield* handshake.pipe(
			Effect.tapError(() =>
				Effect.sync(() => {
					child.kill("SIGTERM");
					void stdioMcpFallback.close();
					void mcpGatewaySession.close();
				}),
			),
		);
		acpSessionId = acquiredSession.sessionId;
		if (acquiredSession.resumed) {
			for (const event of translator.flush()) Queue.offerUnsafe(events, event);
			Queue.offerUnsafe(events, { _tag: "Status", status: "idle" });
		}

		Queue.offerUnsafe(events, {
			_tag: "SessionCursor",
			cursor: acpSessionId,
			strategy: "grok-session-id",
		});

		if (resumeCursor !== null && !acquiredSession.resumed) {
			console.warn(
				`[gemini] previous cursor ${resumeCursor} was unavailable; using new session ${acpSessionId}`,
			);
		}

		const enqueuePrompt = (text: string): void => {
			const sid = acpSessionId;
			if (sid === null) return;
			const compactSnapshot = isCompactCommand(text)
				? startCompactSnapshot(null)
				: null;
			if (compactSnapshot !== null) {
				Queue.offerUnsafe(
					events,
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
					: applyPlanModePrefix(
							currentMode,
							prefixFirstPromptWithWorkspaceInstructions(
								workspaceInstructionsPending,
								text,
							),
						);
			const finalPromptText =
				mcpHintPending && compactSnapshot === null
					? [
							browserMcpPromptHint(),
							...(orchestrationTools === null
								? []
								: [orchestrationMcpPromptHint()]),
							promptText,
						].join("\n\n")
					: promptText;
			mcpHintPending = false;
			if (compactSnapshot === null) workspaceInstructionsPending = undefined;
			inflight = inflight
				.then(async () => {
					if (closed) return;
					if (GEMINI_RPC_TRACE) {
						process.stderr.write(
							`[gemini.prompt] enqueue len=${finalPromptText.length} mode=${currentMode}\n`,
						);
					}
					try {
						await request(
							"session/prompt",
							{
								sessionId: sid,
								prompt: [{ type: "text", text: finalPromptText }],
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
							Queue.offerUnsafe(
								events,
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
							Queue.offerUnsafe(events, {
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
							for (const ev of translator.flush())
								Queue.offerUnsafe(events, ev);
							Queue.offerUnsafe(events, { _tag: "Status", status: "idle" });
						}
					}
				})
				.catch(() => undefined);
		};

		if (input.initialPrompt !== undefined && input.initialPrompt.length > 0) {
			enqueuePrompt(input.initialPrompt);
		}

		const handle: GeminiSessionHandle = {
			events: Stream.fromQueue(events),
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
					Queue.offerUnsafe(events, { _tag: "Interrupted" });
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
					rpc.rejectAll(new Error("Gemini session closed"));
					try {
						child.stdin.end();
					} catch {
						// ignore — stdin may already be closed by the child
					}
					child.kill("SIGTERM");
					rl.close();
					yield* Effect.promise(() => stdioMcpFallback.close());
					yield* Effect.promise(() => mcpGatewaySession.close());
					yield* Queue.end(events);
				}),
			setPermissionMode: (mode) =>
				Effect.sync(() => {
					if (mode === currentMode) return;
					currentMode = mode;
					Queue.offerUnsafe(events, { _tag: "PermissionModeChanged", mode });
				}),
			answerQuestion: () => Effect.void,
		};
		return handle;
	});
