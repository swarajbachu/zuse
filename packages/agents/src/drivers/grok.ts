import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
	type PermissionDecision,
	type PermissionKind,
	type PermissionMode,
	type RuntimeMode,
	type StartSessionInput,
	ThreadGoal,
	type ThreadGoalSetInput,
	type UserQuestionAnswer,
} from "@zuse/contracts";
import { type Cause, Effect, Queue, Stream } from "effect";
import { ACP_CLIENT_CAPABILITIES } from "../kernel/acp-capabilities.ts";
import { formatAcpError } from "../kernel/acp-error.ts";
import { makeAcpPermissionContext } from "../kernel/acp-permission-context.ts";
import { createAcpSession } from "../kernel/acp-session.ts";
import { AttachmentService } from "../kernel/attachment-service.ts";
import type { GoalCapableSessionHandle } from "../kernel/driver.ts";
import type { ToolCategory } from "../kernel/permission-policy.ts";
import { getBashPolicy, getFsPolicy, getToolPolicy } from "../kernel/policy.ts";
import { issueProviderMcpSession } from "../kernel/provider-mcp-session.ts";
import { makeStdioMcpFallback } from "../kernel/stdio-mcp-fallback.ts";
import { prefixFirstPromptWithWorkspaceInstructions } from "../kernel/workspace-instructions.ts";
import { handleFsRequest } from "./acp/fs.ts";
import { isIgnorableGrokAuthNoise } from "./acp/grok-auth-noise.ts";
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
 * Live-only handle for one Grok conversation. Mirrors Codex/Claude handle
 * shape so `ProviderService` routes RPCs without caring which provider
 * backs the session.
 *
 * Grok has no embeddable JS SDK; instead we drive it via ACP — the agent
 * runs as `grok agent stdio`, a JSON-RPC server on stdin/stdout. One
 * persistent child per session (Claude-style), not one spawn per turn
 * (Codex-style). The conversation is identified by an ACP-minted
 * `sessionId` returned from `session/new`; we surface that as a
 * `SessionCursor { strategy: "grok-session-id" }` so it persists.
 */
export interface GrokSessionHandle extends GoalCapableSessionHandle {
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
	 * No ACP `UserQuestion` primitive yet — match Codex/Grok-headless and
	 * stay a no-op so RPC routing remains uniform.
	 */
	readonly answerQuestion: (
		itemId: AgentItemId,
		answers: ReadonlyArray<UserQuestionAnswer>,
	) => Effect.Effect<void>;
	/**
	 * Goal mode. Grok exposes `/goal` as a native slash command but ACP has no
	 * structured `thread/goal/*` round-trip (unlike Codex). So goal state is
	 * kept driver-local and the objective is forwarded to Grok's native `/goal`
	 * command as prompt text — the same emulation shape as plan mode
	 * (`applyPlanModePrefix`). `tokensUsed`/`timeUsedSeconds` are best-effort
	 * (Grok does not report them back over ACP).
	 */
	readonly getGoal: () => Effect.Effect<ThreadGoal | null>;
	readonly setGoal: (goal: ThreadGoalSetInput) => Effect.Effect<ThreadGoal>;
	readonly clearGoal: () => Effect.Effect<void>;
}

const MCP_CONFIG_START = "# >>> zuse-generated-mcp: do not edit";
const MCP_CONFIG_END = "# <<< zuse-generated-mcp";
const LEGACY_BROWSER_MCP_CONFIG_START =
	"# >>> zuse-generated-browser-mcp: do not edit";
const LEGACY_BROWSER_MCP_CONFIG_END = "# <<< zuse-generated-browser-mcp";

const stripGeneratedMcpConfig = (value: string): string =>
	value
		.replace(
			new RegExp(`\\n?${MCP_CONFIG_START}[\\s\\S]*?${MCP_CONFIG_END}\\n?`, "g"),
			"\n",
		)
		.replace(
			new RegExp(
				`\\n?${LEGACY_BROWSER_MCP_CONFIG_START}[\\s\\S]*?${LEGACY_BROWSER_MCP_CONFIG_END}\\n?`,
				"g",
			),
			"\n",
		)
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd();

const installProjectMcpConfig = (
	cwd: string,
	tomlBlocks: ReadonlyArray<string>,
): (() => void) => {
	const grokDir = join(cwd, ".grok");
	const configPath = join(grokDir, "config.toml");
	const previous = existsSync(configPath)
		? readFileSync(configPath, "utf8")
		: "";
	const userConfig = stripGeneratedMcpConfig(previous);
	const generatedToml = tomlBlocks.map((block) => block.trimEnd()).join("\n");
	const next = `${userConfig.length > 0 ? `${userConfig}\n\n` : ""}${MCP_CONFIG_START}\n${generatedToml}\n${MCP_CONFIG_END}\n`;

	mkdirSync(grokDir, { recursive: true });
	writeFileSync(configPath, next, "utf8");
	console.info(`[grok.mcp] wrote project MCP config ${configPath}`);

	return () => {
		try {
			if (userConfig.length > 0) {
				writeFileSync(configPath, `${userConfig}\n`, "utf8");
			} else {
				rmSync(configPath, { force: true });
			}
		} catch (cause) {
			console.warn(
				`[grok.mcp] could not restore project MCP config ${configPath}: ${
					cause instanceof Error ? cause.message : String(cause)
				}`,
			);
		}
	};
};

/**
 * Diagnostic logging for the Grok ACP driver.
 *
 *   MEMOIZE_DEBUG_GROK=1        → full RPC trace + diag dumps (recommended when debugging "stops" or auth errors)
 *   MEMOIZE_DEBUG_GROK_DIAG=1   → only the high-value diagnostic dumps (lighter than full RPC trace)
 *
 * When the agent "just stops" or you see repeated AuthorizationRequired:
 *   1. Run the desktop app from a terminal (`bun run dev` or the packaged build).
 *   2. `export MEMOIZE_DEBUG_GROK=1`
 *   3. Reproduce the failure.
 *   4. Look for lines starting with `[grok.stderr]`, `[grok.diag]`, and `[grok.rpc]`.
 *      The last 2–4 kB of stderr right before a fatal is usually the smoking gun.
 */
const GROK_RPC_TRACE = process.env.MEMOIZE_DEBUG_GROK === "1";
const GROK_DIAG =
	process.env.MEMOIZE_DEBUG_GROK === "1" ||
	process.env.MEMOIZE_DEBUG_GROK_DIAG === "1";

// Single source of truth for the user-facing auth failure message so the
// two variants the user reported ("Run `grok login` again or verify..." vs
// the slightly longer "Your cached login may have expired...") never diverge.
export const GROK_AUTH_REQUIRED_MESSAGE =
	"Grok authentication failed (AuthorizationRequired). " +
	"Run `grok login` again or verify that your account has SuperGrok or X Premium+. " +
	"If the problem persists after logging in, check your plan at https://x.ai/.";

/** Always-on diagnostic helper. Use for anything that helps root-cause "it stops". */
const grokDiag = (label: string, data?: unknown): void => {
	if (!GROK_DIAG && !GROK_RPC_TRACE) return;
	const prefix = `[grok.diag] ${label}`;
	if (data === undefined) {
		process.stderr.write(`${prefix}\n`);
	} else {
		try {
			const s = typeof data === "string" ? data : JSON.stringify(data, null, 2);
			process.stderr.write(`${prefix}: ${s}\n`);
		} catch {
			process.stderr.write(`${prefix}: (unserialisable)\n`);
		}
	}
};

const appendGrokAcpLog = (
	cwd: string,
	entry: Record<string, unknown>,
): void => {
	try {
		const dir = join(cwd, ".context");
		mkdirSync(dir, { recursive: true });
		appendFileSync(
			join(dir, "grok-acp.log"),
			`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
			"utf8",
		);
	} catch {
		// Best-effort local diagnostics only.
	}
};

type GrokNativePermissionContext = {
	readonly requestPermission: (
		kind: PermissionKind,
		options: { readonly forcePrompt: boolean },
	) => Promise<PermissionDecision>;
	readonly getRuntimeMode: () => RuntimeMode;
	readonly getPermissionMode: () => PermissionMode;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;

const lower = (value: string): string => value.toLowerCase();

export const isGrokNativePermissionMethod = (method: string): boolean => {
	const m = lower(method);
	return (
		m.includes("permission") ||
		m.includes("approval") ||
		m.includes("authorize") ||
		m.includes("authorization") ||
		m.includes("canusetool") ||
		m.includes("can_use_tool") ||
		m.includes("request_tool")
	);
};

const firstStringByKey = (
	value: unknown,
	keys: ReadonlySet<string>,
	depth = 0,
): string | null => {
	if (depth > 5) return null;
	if (typeof value === "string") return null;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = firstStringByKey(item, keys, depth + 1);
			if (found !== null) return found;
		}
		return null;
	}
	const record = asRecord(value);
	if (record === null) return null;
	for (const [key, item] of Object.entries(record)) {
		if (keys.has(lower(key)) && typeof item === "string" && item.length > 0) {
			return item;
		}
	}
	for (const item of Object.values(record)) {
		const found = firstStringByKey(item, keys, depth + 1);
		if (found !== null) return found;
	}
	return null;
};

const stringifyCompact = (value: unknown, max = 220): string => {
	const raw =
		typeof value === "string"
			? value
			: (() => {
					try {
						return JSON.stringify(value);
					} catch {
						return String(value);
					}
				})();
	return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
};

const COMMAND_KEYS = new Set([
	"command",
	"cmd",
	"shellcommand",
	"shell_command",
	"displaycommand",
	"display_command",
]);
const PATH_KEYS = new Set([
	"path",
	"filepath",
	"file_path",
	"targetpath",
	"target_path",
	"destination",
	"newpath",
	"new_path",
]);
const URL_KEYS = new Set(["url", "uri", "href", "target"]);
const TOOL_KEYS = new Set([
	"tool",
	"toolname",
	"tool_name",
	"name",
	"kind",
	"title",
]);
const SUMMARY_KEYS = new Set([
	"reason",
	"summary",
	"description",
	"prompt",
	"message",
	"question",
]);

type ClassifiedGrokPermission = {
	readonly kind: PermissionKind;
	readonly category: ToolCategory;
	readonly path?: string;
};

const classifyGrokNativePermission = (
	method: string,
	params: unknown,
): ClassifiedGrokPermission => {
	const command = firstStringByKey(params, COMMAND_KEYS);
	const path = firstStringByKey(params, PATH_KEYS);
	const url = firstStringByKey(params, URL_KEYS);
	const tool = firstStringByKey(params, TOOL_KEYS) ?? method;
	const toolKey = lower(tool);
	const toolTokens = new Set(
		tool
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((token) => token.length > 0),
	);

	if (
		command !== null ||
		toolKey.includes("shell") ||
		toolKey.includes("bash") ||
		toolKey.includes("terminal")
	) {
		return {
			kind: { _tag: "Bash", command: command ?? tool },
			category: "execute",
		};
	}
	const mutates = [
		"create",
		"delete",
		"edit",
		"move",
		"patch",
		"post",
		"put",
		"replace",
		"upload",
		"write",
	].some((verb) => toolTokens.has(verb));
	if (mutates) {
		return {
			kind: { _tag: "FileWrite", path: path ?? url ?? tool },
			category: "edit",
		};
	}
	const reads = [
		"fetch",
		"find",
		"get",
		"glob",
		"grep",
		"inspect",
		"list",
		"read",
		"search",
		"stat",
		"view",
		"web",
	].some((verb) => toolTokens.has(verb));
	if (reads) {
		return {
			kind:
				url !== null
					? { _tag: "Network", url }
					: {
							_tag: "Other",
							tool,
							summary: path ?? stringifyCompact(params),
						},
			category: "read",
			...(path !== null ? { path } : {}),
		};
	}
	if (path !== null) {
		return { kind: { _tag: "FileWrite", path }, category: "edit" };
	}

	return {
		kind: {
			_tag: "Other",
			tool,
			summary:
				firstStringByKey(params, SUMMARY_KEYS) ?? stringifyCompact(params),
		},
		category: "other",
	};
};

const nativePermissionPolicy = (
	permission: ClassifiedGrokPermission,
	runtimeMode: RuntimeMode,
	permissionMode: PermissionMode,
):
	| { readonly kind: "auto-allow" }
	| { readonly kind: "auto-deny" }
	| {
			readonly kind: "prompt";
			readonly forcePrompt: boolean;
	  } => {
	const { kind } = permission;
	switch (kind._tag) {
		case "Bash":
			return getBashPolicy(kind.command, runtimeMode, permissionMode);
		case "FileWrite":
			return getFsPolicy("write", kind.path, runtimeMode, permissionMode);
		case "Network":
		case "Other":
			if (permission.category === "read" && permission.path !== undefined) {
				return getFsPolicy(
					"read",
					permission.path,
					runtimeMode,
					permissionMode,
				);
			}
			return getToolPolicy(permission.category, runtimeMode, permissionMode);
	}
};

const grokPermissionResponse = (allowed: boolean): Record<string, unknown> =>
	allowed
		? {
				outcome: "approved",
				decision: "approved",
				approved: true,
				allow: true,
				allowed: true,
			}
		: {
				outcome: "denied",
				decision: "denied",
				approved: false,
				allow: false,
				allowed: false,
			};

export const handleGrokNativePermissionRequest = async (
	method: string,
	params: unknown,
	ctx: GrokNativePermissionContext,
): Promise<unknown | null> => {
	if (!isGrokNativePermissionMethod(method)) return null;

	const permission = classifyGrokNativePermission(method, params);
	const policy = nativePermissionPolicy(
		permission,
		ctx.getRuntimeMode(),
		ctx.getPermissionMode(),
	);
	if (policy.kind === "auto-allow") return grokPermissionResponse(true);
	if (policy.kind === "auto-deny") return grokPermissionResponse(false);

	const decision = await ctx.requestPermission(permission.kind, {
		forcePrompt: policy.forcePrompt,
	});
	return grokPermissionResponse(decision._tag !== "Deny");
};

/**
 * Detect fatal authorization failures from the grok agent's own stderr.
 * When the cached token is missing/expired/insufficient (Grok paid tier
 * tier required), the agent prints:
 *   "worker quit with fatal: Transport channel closed, when Auth(AuthorizationRequired)"
 * and dies. We watch for this in real time so we can fail the in-flight
 * prompt *immediately* instead of waiting for the 5-minute timeout, and
 * we surface the single canonical GROK_AUTH_REQUIRED_MESSAGE.
 */
const isFatalAuthError = (text: string): boolean => {
	const t = text.toLowerCase();
	// Be very strict. The grok binary routinely logs auth state, "waiting",
	// bare `Auth(AuthorizationRequired)`, etc. during normal cached-token
	// refresh on startup — those are NOT fatal. Only treat as fatal when we
	// see one of the "the worker actually died" signals.
	return (
		(t.includes("worker quit with fatal") &&
			t.includes("authorizationrequired")) ||
		(t.includes("transport channel closed") &&
			t.includes("authorizationrequired"))
	);
};

/**
 * How long after spawn we treat fatal-auth stderr signals as transient noise.
 * The handshake (initialize → authenticate → session/new) finishes in ~1–2s;
 * a 4s window absorbs the cached-token refresh chatter that otherwise lights
 * up a red error card on the user's very first message.
 */
const GROK_STARTUP_GRACE_MS = 4_000;

/**
 * Turn a raw stderr snippet (from the grok binary) into a user-friendly
 * error message. When we see the known fatal auth line we produce the
 * canonical GROK_AUTH_REQUIRED_MESSAGE.
 */
const friendlyErrorFromStderr = (rawTail: string): string | null => {
	if (!isFatalAuthError(rawTail)) return null;
	return GROK_AUTH_REQUIRED_MESSAGE;
};

/**
 * Spin up a Grok conversation backed by a persistent ACP child process.
 * The handshake (`initialize` → `authenticate` → `session/new`) runs once
 * synchronously inside `start()`; auth or transport failures surface there
 * so the orchestrator can fail the session-create RPC cleanly.
 *
 * `apiKey` is forwarded as `GROK_CODE_XAI_API_KEY` on the child env. When
 * null the child reads cached credentials from `~/.grok/` (browser-OAuth
 * `grok login` flow). `xai.api_key` auth method is preferred when a key
 * is set; otherwise `cached_token`.
 */
export const startGrokSession = (
	input: StartSessionInput,
	cwd: string,
	apiKey: string | null,
	grokPath: string,
	browserMcpCommand: string,
	sessionId: AgentSessionId,
	requestPermission: RequestPermission,
	getRuntimeMode: GetRuntimeMode,
	browserSend: BrowserSend,
	orchestrationTools: OrchestrationSessionTools | null = null,
	resumeCursor: string | null = null,
): Effect.Effect<
	GrokSessionHandle,
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

		// Shared context handed to the ACP fs/* and terminal/* handlers so file
		// writes and command execution are gated through PermissionService +
		// RuntimeMode, exactly like Claude/Codex. `currentMode` is read live so a
		// mid-session mode toggle takes effect on the next tool call.
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
			providerId: "grok",
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
		let restoreProjectMcpConfig: () => void = () => {};

		const ensureStdioFallbackMcp = async () => {
			const configs = await stdioMcpFallback.ensure();
			restoreProjectMcpConfig();
			restoreProjectMcpConfig = installProjectMcpConfig(
				cwd,
				stdioMcpFallback.projectConfigToml(),
			);
			return configs;
		};

		let acpSessionId: string | null = null;
		let closed = false;
		/** Driver-local goal state. Grok has no `thread/goal/*` ACP surface, so we
		 *  track the goal here and forward the objective via the native `/goal`
		 *  slash command. See the goal methods on the handle below. */
		let currentGoal: ThreadGoal | null = null;
		/** True once the ACP child has exited (fatal auth, crash, or normal end).
		 *  Further send() calls fail fast with a clear "session ended — start a new chat" message
		 *  instead of queuing doomed RPCs that will 5-minute timeout.
		 */
		let dead = false;
		// One-shot browser-tools hint for the model. True whenever the ACP
		// server-side context is fresh (initial connect + every respawn); the
		// next session/prompt prepends the browser tool list so the model
		// calls tools directly instead of hunting the filesystem for schemas.
		let browserHintPending = true;
		let inflight: Promise<void> = Promise.resolve();
		let workspaceInstructionsPending = input.workspaceInstructions;
		// Trailing window of grok's stderr — used to enrich error reports when
		// the JSON-RPC envelope itself is opaque ("Internal error" with no data).
		let stderrTail = "";

		// Which auth method the binary accepted for this session.
		// Very useful when debugging "AuthorizationRequired" even with a valid login.
		// Common values: "cached_token" (from `grok login`) or "xai.api_key".
		let authMethodUsed: string | null = null;

		Queue.offerUnsafe(events, {
			_tag: "Started",
			sessionId,
			providerId: "grok",
			mode: "sdk",
		});

		// Per-session translator coalesces agent_message_chunk deltas into
		// one AssistantMessage per burst so the renderer doesn't show one
		// bubble per token.
		const translator = createAcpTranslator("grok");

		let child: ChildProcessWithoutNullStreams;
		let rl: readline.Interface;
		/**
		 * Wall-clock ms when the *current* child was spawned. Used to absorb
		 * benign `Auth(AuthorizationRequired)` stderr chatter the grok binary
		 * prints during cached-token refresh — see [[GROK_STARTUP_GRACE_MS]].
		 */
		let spawnedAt = 0;
		/** Re-spawn the grok child and re-run the ACP handshake. Used both for
		 *  the initial start() path and for transparent recovery after the
		 *  worker dies (auth refresh races, the Grok worker quitting
		 *  mid-session, etc). On success: child/rl/acpSessionId/authMethodUsed
		 *  are populated, dead=false, listeners attached. On failure the
		 *  returned promise rejects and the caller decides whether to surface
		 *  the error or just bubble it. */
		const connectChild = async (
			cursor: string | null,
		): Promise<{ readonly sessionId: string; readonly resumed: boolean }> => {
			child = spawn(grokPath, ["--trust", "agent", "--no-leader", "stdio"], {
				cwd,
				env: {
					...process.env,
					GROK_CURSOR_MCPS_ENABLED: "0",
					...(apiKey !== null ? { GROK_CODE_XAI_API_KEY: apiKey } : {}),
				},
				stdio: ["pipe", "pipe", "pipe"],
			});
			spawnedAt = Date.now();
			stderrTail = "";
			child.stdout.setEncoding("utf-8");
			child.stderr.setEncoding("utf-8");
			rl = readline.createInterface({ input: child.stdout });
			attachListeners();
			return await runHandshake(cursor);
		};

		const writeMessage = (msg: Record<string, unknown>): void => {
			if (!child.stdin.writable) return;
			const line = JSON.stringify(msg);
			if (GROK_RPC_TRACE) process.stderr.write(`[grok.rpc.send] ${line}\n`);
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
					const friendly = friendlyErrorFromStderr(trimmedStderr);
					if (friendly !== null) {
						return new Error(friendly);
					}
					const detail =
						trimmedStderr.length > 0 ? ` — stderr: ${trimmedStderr}` : "";
					return new Error(
						`Grok ACP ${method} timed out after ${timeoutMs}ms${detail}`,
					);
				},
			});

		const notify = (method: string, params: unknown): void => {
			rpc.notify(method, params);
		};

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
			if (GROK_RPC_TRACE) {
				process.stderr.write(
					`[grok.rpc.cancel] force-reject id=${id} method=${cancelled.method} reason=${reason}\n`,
				);
			}
		};

		const attachListeners = (): void => {
			rl.on("line", (line: string) => {
				if (line.trim().length === 0) return;
				if (GROK_RPC_TRACE) process.stderr.write(`[grok.rpc.recv] ${line}\n`);
				const msg = decodeJsonRpcLine(line);
				if (msg === null) {
					// Non-JSON line on stdout (e.g. a tracing log leak). Drop silently
					// — assistant text rides typed `session/update` notifications.
					return;
				}

				// Notifications and server→client requests both carry `method`.
				if (typeof msg.method === "string") {
					if (msg.method === "session/update") {
						const update =
							msg.params !== null && typeof msg.params === "object"
								? (msg.params as Record<string, unknown>).update
								: undefined;
						if (update !== undefined) {
							const translated = translator.translate(update);
							appendGrokAcpLog(cwd, {
								method: msg.method,
								update,
								events: translated,
							});
							for (const ev of translated) {
								Queue.offerUnsafe(events, ev);
							}
						}
						return;
					}

					// Grok swarming / collab agents + general thread/item lifecycle.
					// The ACP server emits item/started, item/completed, thread/* etc.
					// with payloads containing ThreadItem (including collabAgentToolCall)
					// and per-thread metadata (nickname, role, states). Forward the
					// params object to the translator so the new collab handling can
					// extract them. Only log at trace level to avoid noise in normal use.
					if (
						msg.method.startsWith("item/") ||
						msg.method.startsWith("thread/")
					) {
						if (GROK_RPC_TRACE) {
							process.stderr.write(
								`[grok.rpc] ${msg.method} params=${JSON.stringify(msg.params ?? {})}\n`,
							);
						}
						if (msg.params !== undefined) {
							const update = {
								...(msg.params !== null && typeof msg.params === "object"
									? (msg.params as Record<string, unknown>)
									: { params: msg.params }),
								method: msg.method,
							};
							const translated = translator.translate(update);
							appendGrokAcpLog(cwd, {
								method: msg.method,
								params: msg.params,
								events: translated,
							});
							for (const ev of translated) {
								Queue.offerUnsafe(events, ev);
							}
						}
						return;
					}

					if (msg.id !== undefined && msg.id !== null) {
						// Server→client request (fs/*, permission prompts, etc.).
						// We now:
						//  - Log verbosely under the existing GROK_RPC_TRACE flag so the
						//    user (and we) can see exactly which tools Grok tries to call
						//    on the client ("add some logs").
						//  - For fs/* methods we reply with a clean "not implemented yet"
						//    error so the agent does not hang waiting for a response.
						//    This often makes Grok fall back to its own well-named internal
						//    tools (list_dir etc.) which our translator now renders nicely.
						const isFs = msg.method.startsWith("fs/");
						if (GROK_RPC_TRACE || isFs) {
							process.stderr.write(
								`[grok.rpc] server→client request method=${msg.method} id=${msg.id} params=${JSON.stringify(msg.params ?? {})}\n`,
							);
						}
						if (isFs) {
							// Real FS support — the agent can now read/write files directly
							// instead of getting "Method not implemented" tool errors.
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

						if (isGrokNativePermissionMethod(msg.method)) {
							process.stderr.write(
								`[grok.rpc] native permission request method=${msg.method} id=${msg.id} params=${JSON.stringify(msg.params ?? {})}\n`,
							);
							handleGrokNativePermissionRequest(
								msg.method,
								msg.params,
								acpHandlerContext(),
							)
								.then((result) => {
									if (result === null) {
										writeMessage({
											jsonrpc: "2.0",
											id: msg.id,
											error: {
												code: -32601,
												message: `Method not supported by Zuse ACP client: ${msg.method}`,
											},
										});
										return;
									}
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

						// User question / interactive prompts from the Grok agent
						// (e.g. _x.ai/ask_user_question or similar namespaced methods).
						// These are used by the agent when it wants to ask the human for
						// input (dummy edits, confirmations, plan decisions, etc.).
						// For now we auto-ack so the agent's tool call doesn't hang/fail.
						// Full round-trip (emit UserQuestionEvent + route answers back)
						// can be added later once we have the exact param shape.
						const isQuestionMethod =
							msg.method?.includes("ask_user_question") ||
							msg.method?.includes("user_question") ||
							msg.method?.startsWith("_x.ai/");

						if (isQuestionMethod) {
							grokDiag("auto-acking user question method from agent", {
								method: msg.method,
								params: msg.params,
							});
							if (GROK_RPC_TRACE) {
								process.stderr.write(
									`[grok.rpc] auto-acking question method=${msg.method} id=${msg.id} params=${JSON.stringify(msg.params ?? {})}\n`,
								);
							}
							// The Grok ACP expects at minimum an `outcome` field in the
							// result for ask_user_question responses. We auto-approve for
							// dummy flows so the agent can keep making edits without hanging.
							writeMessage({
								jsonrpc: "2.0",
								id: msg.id,
								result: { outcome: "approved" },
							});
							return;
						}

						// For everything else (permission prompts, collab callbacks, etc.)
						// we still reply with a clean error so the agent never hangs forever
						// waiting for a response that will never come.
						const paramsPreview = stringifyCompact(msg.params);
						if (/permission|approval|authoriz/i.test(paramsPreview)) {
							process.stderr.write(
								`[grok.rpc] unrecognized permission-like request method=${msg.method} id=${msg.id} params=${paramsPreview}\n`,
							);
						}
						writeMessage({
							jsonrpc: "2.0",
							id: msg.id,
							error: {
								code: -32601,
								message: `Method not supported by Zuse ACP client: ${msg.method}`,
							},
						});
						grokDiag("replied to unhandled server→client request", {
							method: msg.method,
							id: msg.id,
						});
						return;
					}
					// Unknown notification — drop.
					return;
				}

				// Response to one of our outbound requests.
				rpc.acceptResponse(msg, {
					mapError: (error, context) => {
						try {
							process.stderr.write(
								`[grok.rpc.error] method=${context.method} id=${context.id} ${JSON.stringify(error)}\n`,
							);
						} catch {
							process.stderr.write(
								`[grok.rpc.error] method=${context.method} id=${context.id} (unserialisable)\n`,
							);
						}
						const detail = formatAcpError(error, {
							fallback: "Grok ACP returned an error with no detail.",
							diagnostics: stderrTail,
						});
						return new Error(`Grok ${context.method} failed: ${detail}`);
					},
				});
			});

			child.stderr.on("data", (chunk: string) => {
				// Keep a rolling tail so errors can include the actual stderr
				// context (auth failures, version mismatch, etc.) instead of just
				// grok's generic JSON-RPC "Internal error".
				stderrTail = (stderrTail + chunk).slice(-4096);

				// Always emit the raw stderr from the grok binary. When the agent
				// "just stops" or you see AuthorizationRequired, the lines starting
				// with [grok.stderr] are the primary diagnostic. Run the app from a
				// terminal and `grep -i auth` or `grep -i fatal` on the output.
				process.stderr.write(`[grok.stderr] ${chunk}`);

				// Fast-path: if the agent itself reports a fatal auth failure
				// (token expired / wrong tier), kill the in-flight prompt right now
				// instead of letting the 5-minute timeout fire. This is what the
				// user meant by "not auto stopping".
				const sawFatal =
					isFatalAuthError(chunk) || isFatalAuthError(stderrTail);
				if (sawFatal) {
					// Startup grace window: the grok binary routinely prints
					// Auth(AuthorizationRequired) lines during cached-token refresh
					// *before* the worker actually dies. Treat anything inside the
					// grace window as noise — if the worker really is dead the
					// `close` event will fire and we'll surface that instead.
					const sinceSpawn = Date.now() - spawnedAt;
					if (sinceSpawn < GROK_STARTUP_GRACE_MS) {
						grokDiag(
							"Suppressed fatal-auth stderr inside startup grace window",
							{
								sinceSpawnMs: sinceSpawn,
								graceMs: GROK_STARTUP_GRACE_MS,
								chunkPreview: chunk.slice(0, 400),
							},
						);
						return;
					}

					// Always log the full diagnostic info (this is what we use for debugging).
					grokDiag("FATAL_AUTH_TRIGGERED", {
						chunkPreview: chunk.slice(0, 800),
						tailPreview: stderrTail.slice(-800),
						currentPromptRpcId,
						inflightPending: rpc.pendingCount,
						authMethodUsed,
					});

					if (!closed) {
						grokDiag(
							"Ignored Grok AuthorizationRequired while keeping turn running",
						);
					}
				}
			});

			child.on("error", (err) => {
				if (closed) return;
				dead = true;
				grokDiag("child process error event", { message: err.message });
				// Don't end the mailbox — child errors are almost always followed by a
				// `close` event, and the next send() will trigger a transparent respawn.
				// We still want the diagnostic in the logs.
			});

			child.on("close", (code, signal) => {
				rl.close();
				dead = true;
				const trimmedStderr = stderrTail.trim();
				const friendly = friendlyErrorFromStderr(trimmedStderr);
				const exitDetail =
					friendly !== null
						? friendly
						: trimmedStderr.length > 0
							? `Grok ACP exited (code ${code ?? "null"}, signal ${signal ?? "null"}): ${trimmedStderr}`
							: `Grok ACP exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}).`;

				grokDiag("child process closed", {
					code,
					signal,
					stderrTailLen: trimmedStderr.length,
					hadFriendlyAuthError: friendly !== null,
				});
				if (trimmedStderr.length > 0) {
					grokDiag("final stderr tail (last 2k)", trimmedStderr.slice(-2000));
				}
				rpc.rejectAll(new Error(exitDetail));
				if (!closed) {
					// Keep the mailbox alive — the next send() will transparently respawn
					// the child + redo the handshake (see [[enqueuePrompt]]). Do not stop
					// the visible turn for the known Grok AuthorizationRequired noise.
					if (friendly === null) {
						Queue.offerUnsafe(events, { _tag: "Status", status: "idle" });
					}
					grokDiag(
						"child closed — keeping mailbox alive for transparent respawn on next send",
						{
							friendly: friendly ?? null,
						},
					);
					return;
				}
				// User-initiated close — end the mailbox so Stream consumers terminate.
				Queue.endUnsafe(events);
			});
		}; // end attachListeners

		// === ACP handshake. Used both by the initial start() path and by the
		// transparent respawn path inside enqueuePrompt. Resets `dead` on
		// success so the next prompt can proceed. ===
		const runHandshake = async (
			cursor: string | null,
		): Promise<{ readonly sessionId: string; readonly resumed: boolean }> => {
			const init = (await request("initialize", {
				protocolVersion: 1,
				clientCapabilities: ACP_CLIENT_CAPABILITIES,
			})) as { authMethods?: ReadonlyArray<{ id?: unknown }> };

			const authIds = new Set(
				(init.authMethods ?? [])
					.map((m) => (typeof m?.id === "string" ? m.id : null))
					.filter((id): id is string => id !== null),
			);
			grokDiag("handshake initialize returned authMethods", [...authIds]);

			const methodId =
				apiKey !== null && authIds.has("xai.api_key")
					? "xai.api_key"
					: authIds.has("cached_token")
						? "cached_token"
						: null;
			if (methodId === null) {
				throw new Error(
					"Grok ACP offered no usable auth method. Run `grok login`, or set GROK_CODE_XAI_API_KEY.",
				);
			}
			authMethodUsed = methodId;
			grokDiag("choosing auth method", {
				methodId,
				hasApiKey: apiKey !== null,
			});

			const authResult = await request("authenticate", {
				methodId,
				_meta: { headless: true },
			});
			grokDiag("authenticate succeeded", {
				methodId,
				authMethodUsed,
				result: authResult,
			});

			const httpMcpServers = [
				mcpGatewaySession.httpServerConfigs.browser,
				...(orchestrationTools === null
					? []
					: [mcpGatewaySession.httpServerConfigs.orchestration]),
			];
			const acquisition = await createAcpSession({
				request,
				cwd,
				sessionId,
				providerLabel: "Grok",
				httpServers: httpMcpServers,
				fallbackServers: ensureStdioFallbackMcp,
				resumeCursor: cursor,
			});
			grokDiag(
				acquisition.resumed
					? "session/load succeeded"
					: "session/new succeeded",
				{
					sessionId: acquisition.sessionId,
					authMethodUsed,
				},
			);
			acpSessionId = acquisition.sessionId;
			dead = false;
			// Fresh server-side context → the model hasn't seen the browser-tools
			// hint yet. Re-arm it so the next prompt carries the tool list (also
			// covers transparent respawns after a child death).
			browserHintPending = true;
			return acquisition;
		};

		const initialAcquisition = yield* Effect.tryPromise({
			try: () => connectChild(resumeCursor),
			catch: (cause) =>
				new AgentSessionStartError({
					providerId: "grok",
					reason: cause instanceof Error ? cause.message : String(cause),
				}),
		}).pipe(
			Effect.tapError(() =>
				Effect.sync(() => {
					try {
						child?.kill("SIGTERM");
					} catch {
						// ignore — child may not be alive
					}
					restoreProjectMcpConfig();
					void stdioMcpFallback.close();
					void mcpGatewaySession.close();
				}),
			),
		);
		acpSessionId = initialAcquisition.sessionId;

		Queue.offerUnsafe(events, {
			_tag: "SessionCursor",
			cursor: acpSessionId,
			strategy: "grok-session-id",
		});

		if (resumeCursor !== null && !initialAcquisition.resumed) {
			console.warn(
				`[grok] cursor ${resumeCursor} was unavailable; using replacement session ${acpSessionId}`,
			);
		}

		const enqueuePrompt = (text: string): void => {
			const compactSnapshot = isCompactCommand(text)
				? startCompactSnapshot(null)
				: null;
			if (compactSnapshot !== null) {
				Queue.offerUnsafe(
					events,
					startCompactEvent({ providerId: "grok", snapshot: compactSnapshot }),
				);
			}
			// Plan-mode emulation: grok ACP has no native read-only switch, so
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
			if (compactSnapshot === null) workspaceInstructionsPending = undefined;
			inflight = inflight
				.then(async () => {
					if (closed) return;
					// If the previous child died (worker crash, auth fatal, etc.),
					// transparently respawn before sending and load the durable ACP
					// session so provider context survives the worker process.
					if (dead) {
						grokDiag("respawning grok child before send (previous child died)");
						try {
							const acquisition = await connectChild(acpSessionId);
							Queue.offerUnsafe(events, {
								_tag: "SessionCursor",
								cursor: acquisition.sessionId,
								strategy: "grok-session-id",
							});
						} catch (cause) {
							const reason =
								cause instanceof Error ? cause.message : String(cause);
							grokDiag("respawn failed", { reason });
							if (!closed) {
								if (isIgnorableGrokAuthNoise(reason)) {
									grokDiag("Suppressed visible respawn auth-noise error", {
										reason,
									});
								} else {
									Queue.offerUnsafe(events, {
										_tag: "Error",
										message: `Grok respawn failed: ${reason}`,
									});
									Queue.offerUnsafe(events, { _tag: "Status", status: "idle" });
								}
							}
							return;
						}
					}
					const sid = acpSessionId;
					if (sid === null) return;
					// Prepend the browser-tools hint on the first prompt of each fresh
					// ACP context (computed here, after the potential respawn above,
					// so a respawned context gets it too). Compact turns skip it —
					// they replay a synthetic summary, not a user ask.
					const finalPromptText =
						browserHintPending && compactSnapshot === null
							? [
									browserMcpPromptHint(),
									...(orchestrationTools === null
										? []
										: [orchestrationMcpPromptHint()]),
									promptText,
								].join("\n\n")
							: promptText;
					browserHintPending = false;
					if (GROK_RPC_TRACE || GROK_DIAG) {
						process.stderr.write(
							`[grok.prompt] enqueue len=${finalPromptText.length} mode=${currentMode}\n`,
						);
					}
					grokDiag("session/prompt starting", {
						promptLen: finalPromptText.length,
						permissionMode: currentMode,
						model: input.model,
					});
					let keepRunningAfterIgnoredAuthNoise = false;
					let turnWasCancelled = false;
					try {
						await request(
							"session/prompt",
							{
								sessionId: sid,
								prompt: [{ type: "text", text: finalPromptText }],
								// Server may ignore unknown keys; pass mode + model as
								// metadata so a future ACP rev can honour them without a
								// driver change.
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
						if (GROK_RPC_TRACE || GROK_DIAG) {
							process.stderr.write(`[grok.prompt] completed\n`);
						}
						grokDiag("session/prompt completed successfully");
						if (compactSnapshot !== null && !closed) {
							Queue.offerUnsafe(
								events,
								finishCompactEvent({
									itemId: compactSnapshot.itemId,
									providerId: "grok",
									snapshot: compactSnapshot,
									afterTokens: null,
								}),
							);
						}
					} catch (cause) {
						const reason =
							cause instanceof Error ? cause.message : String(cause);
						if (GROK_RPC_TRACE || GROK_DIAG) {
							process.stderr.write(`[grok.prompt] failed: ${reason}\n`);
						}
						grokDiag("session/prompt failed", { reason });
						const isCancellation = /cancel|interrupt/i.test(reason);
						if (isCancellation) turnWasCancelled = true;
						const isGrokAuthNoise = isIgnorableGrokAuthNoise(reason);
						if (isGrokAuthNoise) {
							keepRunningAfterIgnoredAuthNoise = true;
							grokDiag("Suppressed visible session/prompt auth-noise error", {
								reason,
							});
						}
						if (!closed && !isCancellation && !isGrokAuthNoise) {
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
							if (!keepRunningAfterIgnoredAuthNoise) {
								Queue.offerUnsafe(events, { _tag: "Status", status: "idle" });
								// A Grok goal runs as a single forwarded `/goal` turn that
								// loops internally (plan → implement → verify → summarize)
								// and self-terminates. Grok exposes no structured goal-status
								// feed over ACP, so we infer the goal's end from the turn
								// ending: a normal finish marks it "complete"; a user
								// interrupt marks it "paused" (resumable) — either way the
								// banner stops hanging on "Pursuing goal" forever.
								if (currentGoal !== null && currentGoal.status === "active") {
									currentGoal = ThreadGoal.make({
										threadId: currentGoal.threadId,
										objective: currentGoal.objective,
										status: turnWasCancelled ? "paused" : "complete",
										tokenBudget: currentGoal.tokenBudget,
										tokensUsed: currentGoal.tokensUsed,
										timeUsedSeconds: currentGoal.timeUsedSeconds,
										createdAt: currentGoal.createdAt,
										updatedAt: Date.now(),
									});
									Queue.offerUnsafe(events, {
										_tag: "GoalUpdated",
										goal: currentGoal,
									});
								}
							}
						}
					}
				})
				.catch(() => undefined);
		};

		if (input.initialPrompt !== undefined && input.initialPrompt.length > 0) {
			enqueuePrompt(input.initialPrompt);
		}

		const handle: GrokSessionHandle = {
			events: Stream.fromQueue(events),
			send: (text, attachmentRefs) =>
				Effect.sync(() => {
					if (attachmentRefs !== undefined && attachmentRefs.length > 0) {
						// ACP `prompt: [{ type: "image", ... }]` shape isn't wired yet;
						// drop with a warn so the text turn still goes through.
						console.warn(
							`[grok.attach] dropping ${attachmentRefs.length} attachment(s) — ACP image content shape not wired`,
						);
					}
					enqueuePrompt(text);
				}),
			interrupt: () =>
				Effect.sync(() => {
					const sid = acpSessionId;
					if (sid === null) return;
					if (GROK_RPC_TRACE) {
						process.stderr.write(
							`[grok.interrupt] sid=${sid} pendingPrompt=${currentPromptRpcId ?? "(none)"}\n`,
						);
					}
					// Best-effort cancel. We deliberately do NOT SIGINT the child —
					// that would kill the persistent agent and end every future send
					// for this session. If `session/cancel` isn't recognised the
					// server replies with an error we ignore.
					notify("session/cancel", { sessionId: sid });
					// Force-reject the in-flight prompt so the inflight chain
					// unblocks even if grok's ACP doesn't honour `session/cancel`.
					rejectCurrentPrompt("Interrupted by user");
					Queue.offerUnsafe(events, { _tag: "Status", status: "idle" });
				}),
			close: () =>
				Effect.gen(function* () {
					closed = true;
					rpc.rejectAll(new Error("Grok session closed"));
					try {
						child.stdin.end();
					} catch {
						// ignore — stdin may already be closed by the child
					}
					child.kill("SIGTERM");
					rl.close();
					restoreProjectMcpConfig();
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
			getGoal: () => Effect.sync(() => currentGoal),
			setGoal: (goalInput) =>
				Effect.sync(() => {
					const now = Date.now();
					const objective = (
						goalInput.objective ??
						currentGoal?.objective ??
						""
					).trim();
					const status = goalInput.status ?? currentGoal?.status ?? "active";
					const wasActiveWithObjective =
						currentGoal?.status === "active" &&
						(currentGoal?.objective.trim() ?? "") === objective;
					const goal = ThreadGoal.make({
						threadId: acpSessionId ?? "",
						objective,
						status,
						tokenBudget:
							goalInput.tokenBudget !== undefined
								? goalInput.tokenBudget
								: (currentGoal?.tokenBudget ?? null),
						// Grok doesn't report goal accounting back over ACP — best-effort 0.
						tokensUsed: currentGoal?.tokensUsed ?? 0,
						timeUsedSeconds: currentGoal?.timeUsedSeconds ?? 0,
						createdAt: currentGoal?.createdAt ?? now,
						updatedAt: now,
					});
					currentGoal = goal;
					// Only fire the native `/goal` command when a goal newly becomes
					// active with an objective — status-only changes (pause/resume) just
					// update local state so we don't re-launch Grok's run.
					if (
						status === "active" &&
						objective.length > 0 &&
						!wasActiveWithObjective
					) {
						enqueuePrompt(`/goal ${objective}`);
					}
					Queue.offerUnsafe(events, { _tag: "GoalUpdated", goal });
					return goal;
				}),
			clearGoal: () =>
				Effect.sync(() => {
					currentGoal = null;
					Queue.offerUnsafe(events, { _tag: "GoalCleared" });
				}),
		};
		return handle;
	});
