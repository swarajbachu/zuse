import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
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
import type { AcpPermissionContext as SharedAcpPermissionContext } from "../kernel/acp-permission-context.ts";
import { AttachmentService } from "../kernel/attachment-service.ts";
import type { ProviderSessionHandle } from "../kernel/driver.ts";
import { prefixFirstPromptWithWorkspaceInstructions } from "../kernel/workspace-instructions.ts";
import { handleFsRequest } from "./acp/fs.ts";
import { replyToAcpRequest } from "./acp/request-reply.ts";
import { handleTerminalRequest } from "./acp/terminal.ts";
import { createAcpTranslator } from "./acp/translate.ts";
import type { GetRuntimeMode, RequestPermission } from "./claude.ts";
import {
	finishCompactEvent,
	isCompactCommand,
	startCompactEvent,
	startCompactSnapshot,
} from "./compact.ts";

/**
 * Live-only handle for one Cursor Agent conversation. Mirrors Grok's
 * `GrokSessionHandle` shape so `ProviderService` routes RPCs without caring
 * which provider backs the session.
 *
 * Cursor exposes itself as an ACP server via `cursor-agent acp` over
 * stdin/stdout JSON-RPC. One persistent child per session. The conversation
 * is identified by an ACP-minted `sessionId` returned from `session/new`;
 * we surface that as a `SessionCursor { strategy: "cursor-session-id" }`
 * so it round-trips through `ConversationServices` for future resume support.
 */
export interface CursorSessionHandle extends ProviderSessionHandle {
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
	 * Cursor's `cursor/ask_question` extension method isn't wired yet — match
	 * Grok and stay a no-op so RPC routing remains uniform.
	 */
	readonly answerQuestion: (
		itemId: AgentItemId,
		answers: ReadonlyArray<UserQuestionAnswer>,
	) => Effect.Effect<void>;
}

const CURSOR_RPC_TRACE = process.env.MEMOIZE_DEBUG_CURSOR === "1";

/**
 * File-tee location for cursor phase logs. Survives bun dev-server stdout
 * multiplexing so `tail -f ~/.cache/zuse/cursor.log` gives a clean
 * timeline across restarts. Best-effort — falls back to tmpdir if HOME
 * isn't writable.
 */
const CURSOR_LOG_PATH = ((): string => {
	try {
		const base = process.env.HOME ? homedir() : tmpdir();
		const dir = join(base, ".cache", "zuse");
		mkdirSync(dir, { recursive: true });
		return join(dir, "cursor.log");
	} catch {
		return join(tmpdir(), "zuse-cursor.log");
	}
})();

const safeStderrWrite = (line: string): void => {
	if (!process.stderr.writable) return;
	try {
		process.stderr.write(line, () => {});
	} catch {
		// Stderr can be closed by Electron's parent process. Logging must not
		// crash provider module initialization.
	}
};

const writeCursorLog = (line: string): void => {
	safeStderrWrite(line);
	try {
		appendFileSync(CURSOR_LOG_PATH, line);
	} catch {
		// best-effort — file logging shouldn't break the session
	}
};

// One-time banner at module load so the user knows where to tail.
safeStderrWrite(`[cursor] phase logs → ${CURSOR_LOG_PATH}\n`);

type PhaseLogger = (phase: string, detail?: string) => void;

/**
 * Always-on phase logger. Prints `[cursor.t+123ms] phase …` so the user can
 * see where slowness comes from (spawn vs initialize vs authenticate vs
 * session/new vs first prompt → first chunk → completion) without needing
 * to flip MEMOIZE_DEBUG_CURSOR. Tees to a file at CURSOR_LOG_PATH for easy
 * inspection. Granular RPC tracing is still gated by MEMOIZE_DEBUG_CURSOR.
 */
const makePhaseLogger = (tagSuffix: string): PhaseLogger => {
	const t0 = Date.now();
	const tag = `cursor.${tagSuffix.slice(0, 8)}`;
	return (phase: string, detail?: string) => {
		const dt = Date.now() - t0;
		const ts = new Date().toISOString();
		const line = detail
			? `${ts} [${tag} t+${dt}ms] ${phase} — ${detail}\n`
			: `${ts} [${tag} t+${dt}ms] ${phase}\n`;
		writeCursorLog(line);
	};
};

/**
 * Transport handed off from `connectAndAuthenticateCursor` to the per-session
 * code in `startCursorSession`. Owns the child process, the JSON-RPC pending
 * map, and the rl/stderr/error/close listeners. Initial handlers are noops;
 * `startCursorSession` swaps in real handlers when it takes ownership so the
 * same listener set serves both the prewarm idle phase and the live session.
 */
interface CursorReadyTransport {
	readonly child: ChildProcessWithoutNullStreams;
	readonly rl: readline.Interface;
	readonly rpc: AcpRpcClient;
	readonly request: (
		method: string,
		params: unknown,
		timeoutMs?: number,
		onAssignedId?: (id: number) => void,
	) => Promise<unknown>;
	readonly notify: (method: string, params: unknown) => void;
	readonly writeMessage: (msg: Record<string, unknown>) => void;
	readonly getStderrTail: () => string;
	/** Swap in a handler for incoming `session/update` notifications. */
	setSessionUpdateHandler(h: (update: unknown) => void): void;
	/** Swap in a handler for child stderr chunks (after the prewarm tail buffer). */
	setStderrHandler(h: (chunk: string) => void): void;
	/** Swap in a handler for child close. Called with a human-readable detail. */
	setCloseHandler(h: (detail: string) => void): void;
	/** Swap in a handler for spawn-time errors. */
	setSpawnErrorHandler(h: (message: string) => void): void;
	/**
	 * Set the working directory used for sandboxing client-side fs/terminal
	 * requests. Defaults to $HOME during prewarm; `startCursorSession` swaps
	 * in the project cwd as soon as it takes ownership.
	 */
	setSessionCwd(cwd: string): void;
	/**
	 * Wire the permission/runtime-mode callbacks used to gate fs writes and
	 * terminal command execution. Until set (prewarm phase), the handlers fall
	 * back to auto-allow. `startCursorSession` installs the real callbacks on
	 * takeover so commands route through PermissionService.
	 */
	setAcpPermissionContext(ctx: AcpPermissionContext): void;
}

/** Permission/runtime-mode callbacks shared by the ACP fs + terminal handlers. */
type AcpPermissionContext = Omit<SharedAcpPermissionContext, "cwd">;

/**
 * Spawn `cursor-agent acp`, run `initialize` and `authenticate`, return a
 * transport ready for `session/new` or `session/load`. Both the prewarm
 * pump and the live `startCursorSession` path call this — prewarm consumes
 * the result later (after auth has already paid its ~8s cost), saving the
 * user that latency on the very first prompt.
 *
 * The transport's rl/child listeners are installed once here and dispatch
 * through swappable handler slots (initially noops). When `startCursorSession`
 * takes ownership it swaps in real handlers so the same listener set serves
 * both phases without re-attaching to the streams.
 */
const connectAndAuthenticateCursor = async (
	cursorPath: string,
	apiKey: string | null,
	log: PhaseLogger,
): Promise<CursorReadyTransport> => {
	log("spawn", `path=${cursorPath} apiKey=${apiKey === null ? "no" : "yes"}`);
	const child = spawn(cursorPath, ["acp"], {
		cwd: process.env.HOME ?? process.cwd(),
		env: {
			...process.env,
			...(apiKey !== null ? { CURSOR_API_KEY: apiKey } : {}),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	log("spawn-ok", `pid=${child.pid ?? "?"}`);

	child.stdout.setEncoding("utf-8");
	child.stderr.setEncoding("utf-8");
	const rl = readline.createInterface({ input: child.stdout });

	let stderrTail = "";

	// Handler slots — set to noops/sane defaults during prewarm; replaced by
	// startCursorSession on takeover.
	let sessionUpdateHandler: (update: unknown) => void = () => {};
	let stderrHandler: (chunk: string) => void = () => {};
	let closeHandler: (detail: string) => void = () => {};
	let spawnErrorHandler: (message: string) => void = () => {};
	// Sandbox root for client-side fs/terminal requests. Defaults to $HOME
	// until startCursorSession swaps in the project cwd.
	let sessionCwd: string = process.env.HOME ?? process.cwd();
	// Permission/runtime-mode callbacks for fs writes + terminal exec. Empty
	// during prewarm (handlers auto-allow); startCursorSession swaps in the
	// real PermissionService bridge on takeover.
	let acpPermissionContext: AcpPermissionContext = {};
	const acpHandlerContext = () => ({
		cwd: sessionCwd,
		...acpPermissionContext,
	});

	const writeMessage = (msg: Record<string, unknown>): void => {
		if (!child.stdin.writable) return;
		const line = JSON.stringify(msg);
		if (CURSOR_RPC_TRACE) writeCursorLog(`[cursor.rpc.send] ${line}\n`);
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
				const trimmedStderr = stderrTail.trim();
				const detail =
					trimmedStderr.length > 0 ? ` — stderr: ${trimmedStderr}` : "";
				return new Error(
					`Cursor ACP ${method} timed out after ${timeoutMs}ms${detail}`,
				);
			},
		});

	const notify = (method: string, params: unknown): void => {
		rpc.notify(method, params);
	};

	rl.on("line", (line: string) => {
		if (line.trim().length === 0) return;
		if (CURSOR_RPC_TRACE) writeCursorLog(`[cursor.rpc.recv] ${line}\n`);
		const msg = decodeJsonRpcLine(line);
		if (msg === null) return;

		if (typeof msg.method === "string") {
			if (msg.method === "session/update") {
				const update =
					msg.params !== null && typeof msg.params === "object"
						? (msg.params as Record<string, unknown>)["update"]
						: undefined;
				if (update !== undefined) sessionUpdateHandler(update);
				return;
			}

			// `item/*` and `thread/*` server→client notifications are an
			// experimental ACP variant cursor (and forkzero/main grok) emit
			// alongside the standard `session/update`. Forward them through the
			// same session-update handler so the translator sees them.
			if (msg.method.startsWith("item/") || msg.method.startsWith("thread/")) {
				if (CURSOR_RPC_TRACE) {
					writeCursorLog(
						`[cursor.rpc] ${msg.method} params=${JSON.stringify(msg.params ?? {})}\n`,
					);
				}
				if (msg.params !== undefined) sessionUpdateHandler(msg.params);
				return;
			}

			if (msg.id !== undefined && msg.id !== null) {
				const isFs = msg.method.startsWith("fs/");
				const isTerminal = msg.method.startsWith("terminal/");
				if (CURSOR_RPC_TRACE || isFs || isTerminal) {
					writeCursorLog(
						`[cursor.rpc] server→client request method=${msg.method} id=${msg.id} params=${JSON.stringify(msg.params ?? {})}\n`,
					);
				}
				const replyId = msg.id;
				if (isFs) {
					replyToAcpRequest(
						(message) => rpc.send(message),
						replyId,
						handleFsRequest(msg.method, msg.params, acpHandlerContext()),
					);
					return;
				}
				if (isTerminal) {
					replyToAcpRequest(
						(message) => rpc.send(message),
						replyId,
						handleTerminalRequest(msg.method, msg.params, acpHandlerContext()),
					);
					return;
				}
				// Auto-ack agent-initiated user questions until we wire a real UI
				// surface for them. Mirrors the policy main shipped in #98 — the
				// alternative is hanging the agent's turn waiting for a reply.
				if (
					msg.method.includes("ask_user_question") ||
					msg.method.includes("user_question")
				) {
					writeMessage({
						jsonrpc: "2.0",
						id: replyId,
						result: { outcome: "approved" },
					});
					return;
				}
				writeMessage({
					jsonrpc: "2.0",
					id: replyId,
					error: {
						code: -32601,
						message: `Method not supported by Zuse ACP client: ${msg.method}`,
					},
				});
				console.warn(
					`[cursor.rpc] replied to unhandled server→client request method=${msg.method} id=${msg.id}`,
				);
				return;
			}
			return;
		}

		rpc.acceptResponse(msg, {
			mapError: (error, context) => {
				try {
					writeCursorLog(
						`[cursor.rpc.error] method=${context.method} id=${context.id} ${JSON.stringify(error)}\n`,
					);
				} catch {
					writeCursorLog(
						`[cursor.rpc.error] method=${context.method} id=${context.id} (unserialisable)\n`,
					);
				}
				const detail = formatAcpError(error, {
					fallback: "Cursor ACP returned an error with no detail.",
					diagnostics: stderrTail,
				});
				return new Error(`Cursor ${context.method} failed: ${detail}`);
			},
		});
	});

	child.stderr.on("data", (chunk: string) => {
		stderrTail = (stderrTail + chunk).slice(-4096);
		writeCursorLog(`[cursor.stderr] ${chunk}`);
		stderrHandler(chunk);
	});

	// Reject pending requests on spawn-time errors (ENOENT/EACCES) so the
	// initialize handshake fails cleanly instead of waiting for a timeout
	// that never resolves. Mirrors the codex client fix.
	child.once("error", (err) => {
		const message = err instanceof Error ? err.message : String(err);
		rpc.rejectAll(new Error(message));
		spawnErrorHandler(message);
	});

	child.on("close", (code, signal) => {
		rl.close();
		const trimmedStderr = stderrTail.trim();
		const exitDetail =
			trimmedStderr.length > 0
				? `Cursor ACP exited (code ${code ?? "null"}, signal ${signal ?? "null"}): ${trimmedStderr}`
				: `Cursor ACP exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}).`;
		rpc.rejectAll(new Error(exitDetail));
		closeHandler(exitDetail);
	});

	// initialize — short timeout. Old cursor-agent (no `acp` subcommand)
	// silently treats it as a chat prompt; detect and fail fast.
	log("initialize.req");
	const initStart = Date.now();
	let init: { authMethods?: ReadonlyArray<{ id?: unknown }> };
	try {
		init = (await request(
			"initialize",
			{
				protocolVersion: 1,
				clientCapabilities: {
					...ACP_CLIENT_CAPABILITIES,
					_meta: { parameterizedModelPicker: true },
				},
			},
			5_000,
		)) as { authMethods?: ReadonlyArray<{ id?: unknown }> };
	} catch (cause) {
		child.kill("SIGTERM");
		const reason = cause instanceof Error ? cause.message : String(cause);
		if (/timed out/i.test(reason)) {
			throw new Error(
				"Cursor Agent is too old (no ACP support). Run `cursor-agent update` (need ≥ 2025.11) and try again.",
			);
		}
		throw cause;
	}

	const authIds = new Set(
		(init.authMethods ?? [])
			.map((m) => (typeof m?.id === "string" ? m.id : null))
			.filter((id): id is string => id !== null),
	);
	log(
		"initialize.ok",
		`${Date.now() - initStart}ms authMethods=[${Array.from(authIds).join(",") || "(none)"}]`,
	);

	const methodId = authIds.has("cursor_login")
		? "cursor_login"
		: authIds.has("cached_token")
			? "cached_token"
			: null;
	if (methodId === null) {
		child.kill("SIGTERM");
		throw new Error(
			'Cursor is not signed in. Click "Sign in" on the Cursor provider card, run `cursor-agent login` in a terminal, or paste a Cursor API key.',
		);
	}
	log("authenticate.req", `methodId=${methodId}`);
	const authStart = Date.now();
	await request("authenticate", { methodId, _meta: { headless: true } });
	log("authenticate.ok", `${Date.now() - authStart}ms`);

	return {
		child,
		rl,
		rpc,
		request,
		notify,
		writeMessage,
		getStderrTail: () => stderrTail,
		setSessionUpdateHandler(h) {
			sessionUpdateHandler = h;
		},
		setStderrHandler(h) {
			stderrHandler = h;
		},
		setCloseHandler(h) {
			closeHandler = h;
		},
		setSpawnErrorHandler(h) {
			spawnErrorHandler = h;
		},
		setSessionCwd(next) {
			sessionCwd = next;
		},
		setAcpPermissionContext(ctx) {
			acpPermissionContext = ctx;
		},
	};
};

// ====================================================================
// Prewarm pool (size 1) — keeps an authenticated child standing by so the
// first user-triggered session skips the ~8s authenticate roundtrip and
// the spawn cost. After a prewarmed transport is consumed, we
// fire-and-forget a re-prewarm so the *next* session also lands fast.
// ====================================================================

let prewarmSlot: Promise<CursorReadyTransport> | null = null;
let prewarmKey: string | null = null;

const keyFor = (cursorPath: string, apiKey: string | null): string =>
	`${cursorPath}|${apiKey ?? ""}`;

/**
 * Kick off (or refresh) a prewarmed cursor-agent child. Safe to call
 * repeatedly — no-op if a prewarm with the same cursorPath+apiKey is
 * already in flight or settled.
 *
 * Called by `provider-service` at boot, and again right after we consume
 * a prewarmed transport so the next session is also fast.
 */
export const prewarmCursor = (
	cursorPath: string,
	apiKey: string | null,
): void => {
	const key = keyFor(cursorPath, apiKey);
	// If a prewarm for a different config is currently in the slot, drop it
	// (its child will be GC'd when the user takes a fresh one). The user
	// changed credentials or binary path; the old warm child is no longer
	// useful.
	if (prewarmSlot !== null && prewarmKey !== null && prewarmKey !== key) {
		prewarmSlot.then((t) => t.child.kill("SIGTERM")).catch(() => undefined);
		prewarmSlot = null;
		prewarmKey = null;
	}
	if (prewarmSlot !== null) return;

	const log = makePhaseLogger("prewarm");
	prewarmKey = key;
	prewarmSlot = connectAndAuthenticateCursor(cursorPath, apiKey, log).then(
		(transport) => {
			// Wire a default close handler so a child that dies in the slot
			// doesn't leak the promise. Once consumed, startCursorSession will
			// overwrite this.
			transport.setCloseHandler(() => {
				if (prewarmSlot !== null) {
					prewarmSlot = null;
					prewarmKey = null;
				}
			});
			log("prewarm.ready");
			return transport;
		},
		(err) => {
			const reason = err instanceof Error ? err.message : String(err);
			log("prewarm.fail", reason);
			prewarmSlot = null;
			prewarmKey = null;
			throw err;
		},
	);
	// Provider startup intentionally does not await the warm slot. Observe the
	// rejection here as well so process shutdown cannot turn a killed warm child
	// into an unhandled rejection; consumers still receive the original promise.
	void prewarmSlot.catch(() => undefined);
};

/**
 * Pull the prewarmed transport if one is available, otherwise connect
 * fresh. Either way, schedule a re-prewarm so the next session is fast.
 */
const takeReadyCursor = async (
	cursorPath: string,
	apiKey: string | null,
	log: PhaseLogger,
): Promise<CursorReadyTransport> => {
	const key = keyFor(cursorPath, apiKey);
	if (prewarmSlot !== null && prewarmKey === key) {
		const slot = prewarmSlot;
		prewarmSlot = null;
		prewarmKey = null;
		log("prewarm.hit");
		try {
			const transport = await slot;
			// Schedule a re-prewarm in the background.
			setImmediate(() => prewarmCursor(cursorPath, apiKey));
			return transport;
		} catch {
			log("prewarm.broken", "fell back to fresh connect");
		}
	} else if (prewarmSlot !== null) {
		log(
			"prewarm.miss",
			`key mismatch: have=${prewarmKey ?? "(none)"} want=${key}`,
		);
	} else {
		log("prewarm.miss", "no warm child available");
	}
	// No warm child usable — connect fresh and start prewarming in parallel
	// so subsequent sessions still benefit.
	setImmediate(() => prewarmCursor(cursorPath, apiKey));
	return connectAndAuthenticateCursor(cursorPath, apiKey, log);
};

/**
 * Spin up a Cursor Agent conversation backed by a persistent ACP child
 * process. The handshake (`initialize` → `authenticate` → `session/new`)
 * runs once synchronously inside `start()`; auth or transport failures
 * surface there so the orchestrator can fail the session-create RPC
 * cleanly.
 *
 * `apiKey` is forwarded as `CURSOR_API_KEY` on the child env. When null the
 * child reads cached credentials from `cursor-agent login` (browser-OAuth
 * flow). `cursor_login` auth method is preferred when a key is set;
 * otherwise `cached_token`.
 */
export const startCursorSession = (
	input: StartSessionInput,
	cwd: string,
	apiKey: string | null,
	cursorPath: string,
	sessionId: AgentSessionId,
	requestPermission: RequestPermission,
	getRuntimeMode: GetRuntimeMode,
	resumeCursor: string | null = null,
): Effect.Effect<
	CursorSessionHandle,
	AgentSessionStartError,
	AttachmentService
> =>
	Effect.gen(function* () {
		yield* AttachmentService;
		const events = yield* Queue.make<AgentEvent, Cause.Done>();

		let currentMode: PermissionMode = input.permissionMode ?? "default";
		let acpSessionId: string | null = null;
		let closed = false;
		let inflight: Promise<void> = Promise.resolve();
		const log = makePhaseLogger(String(sessionId));
		let promptCount = 0;
		let workspaceInstructionsPending = input.workspaceInstructions;
		let firstChunkSeenForPrompt = false;

		Queue.offerUnsafe(events, {
			_tag: "Started",
			sessionId,
			providerId: "cursor",
			mode: "sdk",
		});

		const translator = createAcpTranslator("cursor");

		log(
			"session.start",
			`cwd=${cwd} model=${input.model ?? "(default)"} mode=${currentMode} apiKey=${apiKey === null ? "no" : "yes"}`,
		);

		// Try to take a prewarmed transport (skips spawn + init + auth, saving
		// ~8s). Falls back to a fresh spawn+handshake on cache miss. Schedules
		// a re-prewarm for the next session either way.
		const transportResult = yield* Effect.tryPromise({
			try: () => takeReadyCursor(cursorPath, apiKey, log),
			catch: (cause) =>
				new AgentSessionStartError({
					providerId: "cursor",
					reason: cause instanceof Error ? cause.message : String(cause),
				}),
		});
		const { child, rl, rpc, request, notify, getStderrTail } = transportResult;

		// The transport (possibly prewarmed in $HOME) needs to know the real
		// project cwd before cursor's fs/* and terminal/* server→client
		// requests start flowing — handleFsRequest sandboxes paths under this.
		transportResult.setSessionCwd(cwd);

		// Gate fs writes + terminal command execution through PermissionService +
		// RuntimeMode, exactly like Claude/Codex/Grok. `currentMode` is read live.
		transportResult.setAcpPermissionContext({
			sessionId,
			projectId: input.folderId,
			requestPermission: (kind, options) =>
				requestPermission(sessionId, kind, options),
			getRuntimeMode,
			getPermissionMode: () => currentMode,
		});

		// === Wire session-level handlers onto the (possibly prewarmed) transport.
		transportResult.setSessionUpdateHandler((update) => {
			if (closed) return;
			if (!firstChunkSeenForPrompt) {
				firstChunkSeenForPrompt = true;
				log("prompt.first-update");
			}

			// Log tool-related frames raw so we can see exactly what shape cursor
			// sends and compare against what the translator produced. Text deltas
			// (agent_message_chunk) and reasoning deltas are skipped — they'd
			// drown the file in noise.
			if (update !== null && typeof update === "object") {
				const u = update as Record<string, unknown>;
				const kind =
					typeof u["sessionUpdate"] === "string"
						? (u["sessionUpdate"] as string)
						: typeof u["type"] === "string"
							? (u["type"] as string)
							: null;
				const isToolish =
					kind === "tool_call" ||
					kind === "tool_call_update" ||
					kind === "tool_result" ||
					kind === "tool_output";
				if (isToolish) {
					let raw: string;
					try {
						raw = JSON.stringify(u);
					} catch {
						raw = "(unserialisable)";
					}
					log(
						`update.${kind}`,
						raw.length > 1500 ? `${raw.slice(0, 1500)}…` : raw,
					);
				} else if (
					kind !== null &&
					kind !== "agent_message_chunk" &&
					kind !== "agent_thought_chunk" &&
					kind !== "agent_reasoning_chunk" &&
					kind !== "thinking_chunk" &&
					kind !== "reasoning" &&
					kind !== "message"
				) {
					// Other frames (mode updates, available commands, errors) —
					// log compact form so we can spot anything unusual.
					log(`update.${kind}`);
				}
			}

			const translated = translator.translate(update);
			// Mirror what the translator emitted from this update so we can see
			// the cursor-frame → AgentEvent mapping side-by-side in the log.
			for (const ev of translated) {
				if (ev._tag === "ToolUse") {
					let inputPreview: string;
					try {
						inputPreview = JSON.stringify(ev.input);
					} catch {
						inputPreview = "(unserialisable)";
					}
					log(
						"emit.ToolUse",
						`id=${ev.itemId} tool=${ev.tool} input=${inputPreview.slice(0, 600)}`,
					);
				} else if (ev._tag === "ToolResult") {
					let outputPreview: string;
					try {
						outputPreview =
							typeof ev.output === "string"
								? ev.output
								: JSON.stringify(ev.output);
					} catch {
						outputPreview = "(unserialisable)";
					}
					log(
						"emit.ToolResult",
						`id=${ev.itemId} isError=${ev.isError} output=${outputPreview.slice(0, 400)}`,
					);
				}
				Queue.offerUnsafe(events, ev);
			}
		});
		transportResult.setStderrHandler(() => {
			// Already file-tee'd inside the transport; no extra work needed.
		});
		transportResult.setSpawnErrorHandler((message) => {
			if (!closed) Queue.offerUnsafe(events, { _tag: "Error", message });
		});
		transportResult.setCloseHandler((exitDetail) => {
			log(
				"child.close",
				`pending=${rpc.pendingCount} detail=${exitDetail.slice(0, 200)}`,
			);
			if (!closed) {
				Queue.offerUnsafe(events, { _tag: "Error", message: exitDetail });
				Queue.offerUnsafe(events, { _tag: "Status", status: "idle" });
			}
		});

		/**
		 * Currently in-flight `session/prompt` rpc id. See gemini.ts for the
		 * rationale — interrupt needs to force-reject the pending request so
		 * the `inflight` chain unblocks.
		 */
		let currentPromptRpcId: number | null = null;
		const rejectCurrentPrompt = (reason: string): void => {
			const id = currentPromptRpcId;
			if (id === null) return;
			const cancelled = rpc.cancel(id, new Error(reason));
			if (cancelled === null) return;
			currentPromptRpcId = null;
			if (CURSOR_RPC_TRACE) {
				writeCursorLog(
					`[cursor.rpc.cancel] force-reject id=${id} method=${cancelled.method} reason=${reason}\n`,
				);
			}
		};

		// === session/load or session/new ===
		const sessionStart = Effect.tryPromise({
			try: async () => {
				if (resumeCursor !== null && resumeCursor.length > 0) {
					log("session-load.req", `cursor=${resumeCursor.slice(0, 12)}…`);
					const loadStart = Date.now();
					try {
						await request("session/load", {
							sessionId: resumeCursor,
							cwd,
							mcpServers: [],
						});
						log(
							"session-load.ok",
							`${Date.now() - loadStart}ms acpSessionId=${resumeCursor.slice(0, 12)}…`,
						);
						return resumeCursor;
					} catch (cause) {
						const reason =
							cause instanceof Error ? cause.message : String(cause);
						log(
							"session-load.fail",
							`${Date.now() - loadStart}ms reason=${reason} — falling back to session/new`,
						);
					}
				}

				log("session-new.req");
				const newStart = Date.now();
				const sessionResult = (await request("session/new", {
					cwd,
					mcpServers: [],
				})) as { sessionId?: unknown };

				if (typeof sessionResult.sessionId !== "string") {
					throw new Error("Cursor ACP session/new returned no sessionId.");
				}
				log(
					"session-new.ok",
					`${Date.now() - newStart}ms acpSessionId=${sessionResult.sessionId.slice(0, 12)}…`,
				);
				return sessionResult.sessionId;
			},
			catch: (cause) =>
				new AgentSessionStartError({
					providerId: "cursor",
					reason: cause instanceof Error ? cause.message : String(cause),
				}),
		});

		acpSessionId = yield* sessionStart.pipe(
			Effect.tapError(() =>
				Effect.sync(() => {
					child.kill("SIGTERM");
				}),
			),
		);

		Queue.offerUnsafe(events, {
			_tag: "SessionCursor",
			cursor: acpSessionId,
			strategy: "cursor-session-id",
		});

		if (resumeCursor !== null && resumeCursor !== acpSessionId) {
			log(
				"resume.miss",
				`requested=${resumeCursor.slice(0, 12)}… booted=${acpSessionId.slice(0, 12)}… (load failed; new session)`,
			);
		} else if (resumeCursor !== null) {
			log("resume.hit", `cursor=${acpSessionId.slice(0, 12)}…`);
		}

		// Apply the requested model via ACP `session/set_config_option`. Old
		// `_meta.model` slot on `session/prompt` was a no-op. Fire-and-forget:
		// if the slug isn't accepted the session still works on the default
		// (composer-2) model.
		if (input.model !== undefined && input.model.length > 0) {
			const resolvedModel = resolveModelSlug("cursor", input.model);
			if (resolvedModel !== input.model) {
				log("set-model.alias", `${input.model} → ${resolvedModel}`);
			}
			log("set-model.req", `model=${resolvedModel}`);
			const modelStart = Date.now();
			void request(
				"session/set_config_option",
				{
					sessionId: acpSessionId,
					configId: "model",
					value: resolvedModel,
				},
				5_000,
			)
				.then(() => log("set-model.ok", `${Date.now() - modelStart}ms`))
				.catch((err) => {
					const reason = err instanceof Error ? err.message : String(err);
					log(
						"set-model.fail",
						`${Date.now() - modelStart}ms reason=${reason}`,
					);
				});
		}

		if (currentMode === "plan") {
			notify("session/setMode", { sessionId: acpSessionId, modeId: "plan" });
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
						providerId: "cursor",
						snapshot: compactSnapshot,
					}),
				);
			}
			const promptText =
				compactSnapshot !== null
					? text.trim()
					: prefixFirstPromptWithWorkspaceInstructions(
							workspaceInstructionsPending,
							text,
						);
			if (compactSnapshot === null) workspaceInstructionsPending = undefined;
			const n = ++promptCount;
			inflight = inflight
				.then(async () => {
					if (closed) return;
					firstChunkSeenForPrompt = false;
					const promptStart = Date.now();
					log(
						"prompt.send",
						`#${n} len=${promptText.length} mode=${currentMode}`,
					);
					try {
						await request(
							"session/prompt",
							{
								sessionId: sid,
								prompt: [{ type: "text", text: promptText }],
								_meta: { permissionMode: currentMode },
							},
							5 * 60_000,
							(id) => {
								currentPromptRpcId = id;
							},
						);
						log("prompt.done", `#${n} ${Date.now() - promptStart}ms`);
						if (compactSnapshot !== null && !closed) {
							Queue.offerUnsafe(
								events,
								finishCompactEvent({
									itemId: compactSnapshot.itemId,
									providerId: "cursor",
									snapshot: compactSnapshot,
									afterTokens: null,
								}),
							);
						}
					} catch (cause) {
						const reason =
							cause instanceof Error ? cause.message : String(cause);
						log(
							"prompt.fail",
							`#${n} ${Date.now() - promptStart}ms reason=${reason}`,
						);
						const isCancellation = /cancel|interrupt/i.test(reason);
						if (!closed && !isCancellation) {
							Queue.offerUnsafe(events, { _tag: "Error", message: reason });
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

		// Reference getStderrTail so the param is consumed (linting); transport
		// already file-tees, but we hold the handle for future debug surfaces.
		void getStderrTail;
		void rejectCurrentPrompt;

		const handle: CursorSessionHandle = {
			events: Stream.fromQueue(events),
			send: (text, attachmentRefs) =>
				Effect.sync(() => {
					if (attachmentRefs !== undefined && attachmentRefs.length > 0) {
						console.warn(
							`[cursor.attach] dropping ${attachmentRefs.length} attachment(s) — ACP image content shape not wired`,
						);
					}
					enqueuePrompt(text);
				}),
			interrupt: () =>
				Effect.sync(() => {
					const sid = acpSessionId;
					if (sid === null) return;
					notify("session/cancel", { sessionId: sid });
				}),
			close: () =>
				Effect.gen(function* () {
					closed = true;
					rpc.rejectAll(new Error("Cursor session closed"));
					try {
						child.stdin.end();
					} catch {
						// ignore — stdin may already be closed by the child
					}
					child.kill("SIGTERM");
					rl.close();
					yield* Queue.end(events);
				}),
			setPermissionMode: (mode) =>
				Effect.sync(() => {
					if (mode === currentMode) return;
					currentMode = mode;
					Queue.offerUnsafe(events, { _tag: "PermissionModeChanged", mode });
					const sid = acpSessionId;
					if (sid !== null) {
						const modeId = mode === "plan" ? "plan" : "code";
						notify("session/setMode", { sessionId: sid, modeId });
					}
				}),
			answerQuestion: () => Effect.void,
		};
		return handle;
	});
