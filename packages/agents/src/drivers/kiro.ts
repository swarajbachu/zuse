import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
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
	resolveModelSlug,
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
import { buildAcpPromptContent } from "./acp-image-content.ts";
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
 * Live-only handle for one Kiro conversation. Mirrors the Gemini/Grok/Claude
 * handle shape so `ProviderService` routes RPCs without caring which provider
 * backs the session.
 *
 * AWS Kiro CLI exposes an ACP server via `kiro-cli acp` — JSON-RPC over
 * stdin/stdout. One persistent child per session (Claude-style). The
 * conversation is identified by an ACP-minted `sessionId` from
 * `session/new`; we surface that as
 * `SessionCursor { strategy: "kiro-session-id" }`.
 *
 * Auth is handled by the CLI itself (AWS Builder ID / IAM Identity Center
 * via `kiro-cli login`). ACP `initialize` returns an empty `authMethods`
 * list, so we skip the ACP `authenticate` step.
 *
 * Docs: https://kiro.dev/docs/cli/acp/
 */
export interface KiroSessionHandle extends ProviderSessionHandle {
	readonly events: Stream.Stream<AgentEvent>;
	readonly send: (
		text: string,
		attachments?: ReadonlyArray<AttachmentRef>,
	) => Effect.Effect<void>;
	readonly interrupt: () => Effect.Effect<void>;
	readonly close: () => Effect.Effect<void>;
	/**
	 * Cached locally and passed as `_meta.permissionMode` on the next
	 * `session/prompt`. Kiro also supports `session/set_mode` for agent
	 * configs (e.g. `kiro_default` / `kiro_planner`); permission mode stays
	 * best-effort on the prompt meta.
	 */
	readonly setPermissionMode: (mode: PermissionMode) => Effect.Effect<void>;
	readonly answerQuestion: (
		itemId: AgentItemId,
		answers: ReadonlyArray<UserQuestionAnswer>,
	) => Effect.Effect<void>;
}

const KIRO_RPC_TRACE = process.env.MEMOIZE_DEBUG_KIRO === "1";

const formatKiroDiagnostics = (diagnostics: string): string => {
	const trimmed = diagnostics.trim();
	if (trimmed.length === 0) return trimmed;
	if (
		/Unknown (?:arguments?|command).*?\bacp\b|unrecognized.*?\bacp\b/is.test(
			trimmed,
		)
	) {
		return [
			"Installed Kiro CLI does not support ACP mode (`kiro-cli acp`).",
			"Upgrade Kiro CLI (e.g. `kiro-cli update`), then restart Zuse.",
		].join("\n");
	}
	return trimmed;
};

/**
 * Map Zuse permission mode to a Kiro agent config when plan mode is active.
 * `kiro_planner` is the specialized planning agent advertised by
 * `session/new` modes; default stays on the user's default agent config.
 */
const kiroModeForPermission = (mode: PermissionMode): string | null => {
	if (mode === "plan") return "kiro_planner";
	return null;
};

/**
 * Spin up a Kiro conversation backed by a persistent ACP child process.
 * The handshake (`initialize` → `session/new` or `session/load`) runs once
 * synchronously inside `start()`; auth or transport failures surface there
 * so the orchestrator can fail the session-create RPC cleanly.
 *
 * Credentials come from the user's existing `kiro-cli login` session
 * (tokens under `~/.aws/sso/cache/kiro-auth-token*.json`). No API key is
 * threaded through env.
 */
export const startKiroSession = (
	input: StartSessionInput,
	cwd: string,
	kiroPath: string,
	sessionId: AgentSessionId,
	requestPermission: RequestPermission,
	getRuntimeMode: GetRuntimeMode,
	browserSend: BrowserSend,
	browserMcpCommand: string,
	orchestrationTools: OrchestrationSessionTools | null = null,
	resumeCursor: string | null = null,
): Effect.Effect<
	KiroSessionHandle,
	AgentSessionStartError,
	AttachmentService
> =>
	Effect.gen(function* () {
		// AttachmentService resolves uploaded image blobs for ACP image content
		// (Kiro advertises promptCapabilities.image).
		const attachments = yield* AttachmentService;
		const events = yield* Queue.make<AgentEvent, Cause.Done>();

		let currentMode: PermissionMode = input.permissionMode ?? "default";

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
			providerId: "kiro",
			sessionId,
			cwd,
			browserSend,
			requestPermission: (kind, options) =>
				requestPermission(sessionId, kind, options),
			getRuntimeMode,
			getPermissionMode: () => currentMode,
			orchestrationTools,
		});

		const stdioMcpFallback = makeStdioMcpFallback({
			command: browserMcpCommand,
			endpoint: mcpGatewaySession.endpoint,
			token: mcpGatewaySession.token,
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
			providerId: "kiro",
			mode: "sdk",
		});

		const translator = createAcpTranslator("kiro");

		const modelId =
			input.model !== undefined
				? resolveModelSlug("kiro", input.model)
				: undefined;

		// Spawn args: model + effort can be set at process start so the first
		// session inherits them without an extra round-trip.
		const spawnArgs: string[] = ["acp"];
		if (modelId !== undefined && modelId.length > 0) {
			spawnArgs.push("--model", modelId);
		}
		const effort = input.modelOptions?.effort;
		if (typeof effort === "string" && effort.length > 0) {
			spawnArgs.push("--effort", effort);
		}

		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(kiroPath, spawnArgs, {
				cwd,
				env: { ...process.env },
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (cause) {
			yield* Queue.end(events);
			return yield* Effect.fail(
				new AgentSessionStartError({
					providerId: "kiro",
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
			if (KIRO_RPC_TRACE) process.stderr.write(`[kiro.rpc.send] ${line}\n`);
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
					const diagnostics = formatKiroDiagnostics(diagnosticTail());
					const detail = diagnostics.length > 0 ? ` — ${diagnostics}` : "";
					return new Error(
						`Kiro ACP ${method} timed out after ${timeoutMs}ms${detail}`,
					);
				},
			});

		const notify = (method: string, params: unknown): void => {
			rpc.notify(method, params);
		};

		/**
		 * Currently in-flight `session/prompt` rpc id. Tracked so
		 * `interrupt()` can send `session/cancel` AND force-reject the
		 * pending request, unblocking the `inflight` promise chain.
		 */
		let currentPromptRpcId: number | null = null;
		const rejectCurrentPrompt = (reason: string): void => {
			const id = currentPromptRpcId;
			if (id === null) return;
			const cancelled = rpc.cancel(id, new Error(reason));
			if (cancelled === null) return;
			currentPromptRpcId = null;
			if (KIRO_RPC_TRACE) {
				process.stderr.write(
					`[kiro.rpc.cancel] force-reject id=${id} method=${cancelled.method} reason=${reason}\n`,
				);
			}
		};

		rl.on("line", (line: string) => {
			if (line.trim().length === 0) return;
			if (KIRO_RPC_TRACE) process.stderr.write(`[kiro.rpc.recv] ${line}\n`);
			const msg = decodeJsonRpcLine(line);
			if (msg === null) {
				stdoutNoiseTail = `${stdoutNoiseTail}${line}\n`.slice(-4096);
				process.stderr.write(`[kiro.stdout.nonjson] ${line}\n`);
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

				// Kiro extension notifications (`_kiro.dev/*`) are optional
				// enhancements (slash commands, MCP lifecycle, compaction,
				// metering). Safe to ignore until we wire dedicated UI for them.
				if (
					msg.method.startsWith("_kiro.") ||
					msg.method.startsWith("_session/")
				) {
					if (KIRO_RPC_TRACE) {
						process.stderr.write(
							`[kiro.rpc] extension ${msg.method} params=${JSON.stringify(msg.params ?? {})}\n`,
						);
					}
					return;
				}

				if (
					msg.method.startsWith("item/") ||
					msg.method.startsWith("thread/")
				) {
					if (msg.params !== undefined) {
						for (const ev of translator.translate(msg.params)) {
							Queue.offerUnsafe(events, ev);
						}
					}
					return;
				}

				if (msg.id !== undefined && msg.id !== null) {
					const isFs = msg.method.startsWith("fs/");
					if (KIRO_RPC_TRACE || isFs) {
						process.stderr.write(
							`[kiro.rpc] server→client request method=${msg.method} id=${msg.id} params=${JSON.stringify(msg.params ?? {})}\n`,
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

					const isQuestionMethod =
						msg.method.includes("ask_user_question") ||
						msg.method.includes("user_question") ||
						msg.method.startsWith("_kiro.");

					if (isQuestionMethod) {
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
						`[kiro.rpc] replied to unhandled server→client request method=${msg.method} id=${msg.id}`,
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
							`[kiro.rpc.error] method=${context.method} id=${context.id} ${rawEnvelope}\n`,
						);
					} catch {
						process.stderr.write(
							`[kiro.rpc.error] method=${context.method} id=${context.id} (unserialisable)\n`,
						);
					}
					const detail = formatAcpError(error, {
						fallback: "Kiro ACP returned an error with no detail.",
						diagnostics: formatKiroDiagnostics(diagnosticTail()),
						appendDiagnostics: true,
						rawEnvelope,
					});
					return new Error(`Kiro ${context.method} failed: ${detail}`);
				},
			});
		});

		child.stderr.on("data", (chunk: string) => {
			stderrTail = (stderrTail + chunk).slice(-4096);
			process.stderr.write(`[kiro.stderr] ${chunk}`);
		});

		child.on("error", (err) => {
			if (closed) return;
			Queue.offerUnsafe(events, { _tag: "Error", message: err.message });
			Queue.endUnsafe(events);
		});

		child.on("close", (code, signal) => {
			rl.close();
			const diagnostics = formatKiroDiagnostics(diagnosticTail());
			const exitDetail =
				diagnostics.length > 0
					? `Kiro ACP exited (code ${code ?? "null"}, signal ${signal ?? "null"}): ${diagnostics}`
					: `Kiro ACP exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}).`;
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
					clientInfo: {
						name: "zuse",
						version: "0.0.0",
					},
				})) as {
					authMethods?: ReadonlyArray<{ id?: unknown }>;
					agentInfo?: { name?: unknown; version?: unknown };
				};

				// Kiro authenticates out-of-band via `kiro-cli login`. When
				// authMethods is empty (the current protocol shape), skip
				// `authenticate` entirely — session/new will fail with a
				// clear error if the CLI is logged out.
				const authIds = new Set(
					(init.authMethods ?? [])
						.map((m) => (typeof m?.id === "string" ? m.id : null))
						.filter((id): id is string => id !== null),
				);
				if (authIds.size > 0) {
					// Prefer any advertised method; headless so we never open a browser.
					const methodId = authIds.values().next().value;
					if (typeof methodId === "string") {
						await request("authenticate", {
							methodId,
							_meta: { headless: true },
						});
					}
				}

				const httpMcpServers = [mcpGatewaySession.serverConfig];
				const acquired = await createAcpSession({
					request,
					cwd,
					sessionId,
					providerLabel: "Kiro",
					httpServers: httpMcpServers,
					fallbackServers: stdioMcpFallback.ensure,
					resumeCursor,
				});

				// Apply model selection post-session when spawn-time --model
				// wasn't enough (e.g. resumed sessions keep their prior model).
				if (modelId !== undefined && modelId.length > 0) {
					try {
						await request("session/set_model", {
							sessionId: acquired.sessionId,
							modelId,
						});
					} catch (cause) {
						// Non-fatal: some older builds may not implement set_model.
						console.warn(
							`[kiro] session/set_model failed: ${
								cause instanceof Error ? cause.message : String(cause)
							}`,
						);
					}
				}

				// Switch into planner agent when plan mode is requested.
				const agentMode = kiroModeForPermission(currentMode);
				if (agentMode !== null) {
					try {
						await request("session/set_mode", {
							sessionId: acquired.sessionId,
							modeId: agentMode,
						});
					} catch (cause) {
						console.warn(
							`[kiro] session/set_mode(${agentMode}) failed: ${
								cause instanceof Error ? cause.message : String(cause)
							}`,
						);
					}
				}

				return acquired;
			},
			catch: (cause) =>
				new AgentSessionStartError({
					providerId: "kiro",
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
			strategy: "kiro-session-id",
		});

		if (resumeCursor !== null && !acquiredSession.resumed) {
			console.warn(
				`[kiro] previous cursor ${resumeCursor} was unavailable; using new session ${acpSessionId}`,
			);
		}

		const enqueuePrompt = (
			text: string,
			attachmentRefs: ReadonlyArray<AttachmentRef> = [],
		): void => {
			const sid = acpSessionId;
			if (sid === null) return;
			const compactSnapshot = isCompactCommand(text)
				? startCompactSnapshot(null)
				: null;
			if (compactSnapshot !== null) {
				Queue.offerUnsafe(
					events,
					startCompactEvent({
						providerId: "kiro",
						snapshot: compactSnapshot,
					}),
				);
			}
			// Plan-mode emulation: also force planner agent; still prefix
			// developer instructions so the model stays read-only if the
			// agent config doesn't enforce it.
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
					const prompt = await buildAcpPromptContent(
						finalPromptText,
						attachmentRefs,
						async (attachment) => {
							const [blob, file] = await Promise.all([
								Effect.runPromise(attachments.read(attachment.id)),
								Effect.runPromise(attachments.readPath(attachment.id)),
							]);
							if (blob === null) return null;
							return {
								bytes: blob.bytes,
								mimeType: blob.mimeType,
								...(file === null ? {} : { path: file.path }),
							};
						},
					);
					if (KIRO_RPC_TRACE) {
						process.stderr.write(
							`[kiro.prompt] enqueue parts=${prompt.length} mode=${currentMode}\n`,
						);
					}
					try {
						await request(
							"session/prompt",
							{
								sessionId: sid,
								prompt,
								_meta: {
									permissionMode: currentMode,
									...(modelId !== undefined ? { model: modelId } : {}),
								},
							},
							5 * 60_000,
							(id) => {
								currentPromptRpcId = id;
							},
						);
						if (KIRO_RPC_TRACE) {
							process.stderr.write(`[kiro.prompt] completed\n`);
						}
						if (compactSnapshot !== null && !closed) {
							Queue.offerUnsafe(
								events,
								finishCompactEvent({
									itemId: compactSnapshot.itemId,
									providerId: "kiro",
									snapshot: compactSnapshot,
									afterTokens: null,
								}),
							);
						}
					} catch (cause) {
						const reason =
							cause instanceof Error ? cause.message : String(cause);
						if (KIRO_RPC_TRACE) {
							process.stderr.write(`[kiro.prompt] failed: ${reason}\n`);
						}
						const isCancellation = /cancel|interrupt/i.test(reason);
						if (!closed && !isCancellation) {
							Queue.offerUnsafe(events, {
								_tag: "Error",
								message: reason,
							});
						}
					} finally {
						currentPromptRpcId = null;
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

		const handle: KiroSessionHandle = {
			events: Stream.fromQueue(events),
			send: (text, attachmentRefs) =>
				Effect.sync(() => {
					enqueuePrompt(text, attachmentRefs ?? []);
				}),
			interrupt: () =>
				Effect.sync(() => {
					const sid = acpSessionId;
					if (sid === null) return;
					if (KIRO_RPC_TRACE) {
						process.stderr.write(
							`[kiro.interrupt] sid=${sid} pendingPrompt=${currentPromptRpcId ?? "(none)"}\n`,
						);
					}
					notify("session/cancel", { sessionId: sid });
					Queue.offerUnsafe(events, { _tag: "Interrupted" });
					rejectCurrentPrompt("Interrupted by user");
				}),
			close: () =>
				Effect.gen(function* () {
					closed = true;
					rpc.rejectAll(new Error("Kiro session closed"));
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
					// Best-effort live agent swap for plan mode.
					const sid = acpSessionId;
					const agentMode = kiroModeForPermission(mode);
					if (sid !== null && agentMode !== null) {
						void request("session/set_mode", {
							sessionId: sid,
							modeId: agentMode,
						}).catch(() => undefined);
					} else if (sid !== null && mode !== "plan") {
						void request("session/set_mode", {
							sessionId: sid,
							modeId: "kiro_default",
						}).catch(() => undefined);
					}
				}),
			answerQuestion: () => Effect.void,
		};
		return handle;
	});
