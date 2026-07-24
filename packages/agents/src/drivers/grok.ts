import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { homedir } from "node:os";
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
	type PermissionDecision,
	type PermissionKind,
	type PermissionMode,
	type PlanApprovalOutcome,
	type RuntimeMode,
	type StartSessionInput,
	ThreadGoal,
	type ThreadGoalSetInput,
	type UserQuestionAnswer,
} from "@zuse/contracts";
import { type Cause, Effect, Queue, Stream } from "effect";
import { ACP_CLIENT_CAPABILITIES } from "../kernel/acp-capabilities.ts";
import { makeAcpPermissionContext } from "../kernel/acp-permission-context.ts";
import { createAcpSession } from "../kernel/acp-session.ts";
import { AttachmentService } from "../kernel/attachment-service.ts";
import type { GoalCapableSessionHandle } from "../kernel/driver.ts";
import type { ToolCategory } from "../kernel/permission-policy.ts";
import { getBashPolicy, getFsPolicy, getToolPolicy } from "../kernel/policy.ts";
import { issueProviderMcpSession } from "../kernel/provider-mcp-session.ts";
import { prefixFirstPromptWithWorkspaceInstructions } from "../kernel/workspace-instructions.ts";
import { handleFsRequest } from "./acp/fs.ts";
import { replyToAcpRequest } from "./acp/request-reply.ts";
import { handleTerminalRequest } from "./acp/terminal.ts";
import { createAcpTranslator } from "./acp/translate.ts";
import { buildAcpPromptContent } from "./acp-image-content.ts";
import type { BrowserSend } from "./browser-tools.ts";
import type { GetRuntimeMode, RequestPermission } from "./claude.ts";
import {
	finishCompactEvent,
	isCompactCommand,
	startCompactEvent,
	startCompactSnapshot,
} from "./compact.ts";
import {
	classifyGrokRpcError,
	createGrokEventCursor,
	createGrokLifecycle,
	decodeAskUserQuestionRequest,
	decodeGrokInitializeResult,
	decodeGrokNotification,
	decodeGrokWireMethod,
	decodePlanApprovalRequest,
	GROK_MINIMUM_VERSION,
	GROK_UPDATE_COMMAND,
	type GrokAskUserQuestionRequest,
	grokSessionFailureAction,
	isSupportedGrokVersion,
	mapGrokMode,
	selectGrokHandshakeAuth,
	translateGrokExtensionMethod,
	translateGrokExtensionUpdate,
} from "./grok/protocol.ts";
import type { OrchestrationSessionTools } from "./orchestration-tools.ts";

class GrokProtocolError extends Error {
	constructor(
		readonly kind: ReturnType<typeof classifyGrokRpcError>,
		message: string,
		readonly sessionMissing = false,
	) {
		super(message);
	}
}

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
	/** Request the native mode; UI state changes only on CurrentModeUpdate. */
	readonly setPermissionMode: (mode: PermissionMode) => Effect.Effect<void>;
	/**
	 * No ACP `UserQuestion` primitive yet — match Codex/Grok-headless and
	 * stay a no-op so RPC routing remains uniform.
	 */
	readonly answerQuestion: (
		itemId: AgentItemId,
		answers: ReadonlyArray<UserQuestionAnswer>,
	) => Effect.Effect<void>;
	readonly respondToPlan: (
		toolCallId: AgentItemId,
		outcome: PlanApprovalOutcome,
		feedback?: string,
	) => Effect.Effect<void>;
	readonly updateMcpServers: (
		servers: ReadonlyArray<unknown>,
	) => Effect.Effect<void>;
	/**
	 * Goal control is sent through native slash commands; state is sourced only
	 * from typed `goal_updated` notifications.
	 */
	readonly getGoal: () => Effect.Effect<ThreadGoal | null>;
	readonly setGoal: (goal: ThreadGoalSetInput) => Effect.Effect<ThreadGoal>;
	readonly clearGoal: () => Effect.Effect<void>;
}

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

const GROK_PERMISSION_METHODS = new Set([
	"permission/request",
	"session/request_permission",
	"tool/requestapproval",
	"tool/canusetool",
]);

export const isGrokNativePermissionMethod = (method: string): boolean =>
	GROK_PERMISSION_METHODS.has(lower(method));

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

const standardAcpPermissionResponse = (
	params: unknown,
	decision: "allow-once" | "allow-always" | "deny",
): Record<string, unknown> => {
	const record = asRecord(params);
	const options = Array.isArray(record?.options) ? record.options : [];
	const preferredKinds =
		decision === "allow-always"
			? ["allow_always", "allow_once"]
			: decision === "allow-once"
				? ["allow_once", "allow_always"]
				: ["reject_once", "reject_always"];
	for (const preferredKind of preferredKinds) {
		const selected = options.find((option) => {
			const candidate = asRecord(option);
			return candidate?.kind === preferredKind;
		});
		const selectedRecord = asRecord(selected);
		const optionId = selectedRecord?.optionId ?? selectedRecord?.option_id;
		if (typeof optionId === "string") {
			return { outcome: { outcome: "selected", optionId } };
		}
	}
	return { outcome: { outcome: "cancelled" } };
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
	const isStandardAcp = method === "session/request_permission";
	if (policy.kind === "auto-allow")
		return isStandardAcp
			? standardAcpPermissionResponse(params, "allow-once")
			: grokPermissionResponse(true);
	if (policy.kind === "auto-deny")
		return isStandardAcp
			? standardAcpPermissionResponse(params, "deny")
			: grokPermissionResponse(false);

	const decision = await ctx.requestPermission(permission.kind, {
		forcePrompt: policy.forcePrompt,
	});
	if (isStandardAcp) {
		return standardAcpPermissionResponse(
			params,
			decision._tag === "Deny"
				? "deny"
				: decision._tag === "AllowForSession" || decision._tag === "AlwaysAllow"
					? "allow-always"
					: "allow-once",
		);
	}
	return grokPermissionResponse(decision._tag !== "Deny");
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
	sessionId: AgentSessionId,
	requestPermission: RequestPermission,
	getRuntimeMode: GetRuntimeMode,
	browserSend: BrowserSend,
	orchestrationTools: OrchestrationSessionTools | null = null,
	resumeCursor: string | null = null,
	providerEventCursor: string | null = null,
): Effect.Effect<
	GrokSessionHandle,
	AgentSessionStartError,
	AttachmentService
> =>
	Effect.gen(function* () {
		const attachments = yield* AttachmentService;
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
			cwd,
			browserSend,
			requestPermission: (kind, options) =>
				requestPermission(sessionId, kind, options),
			getRuntimeMode,
			getPermissionMode: () => currentMode,
			orchestrationTools,
		});
		const grokMcpServers = [
			mcpGatewaySession.httpServerConfigs.images,
			mcpGatewaySession.httpServerConfigs.browser,
			...(orchestrationTools === null
				? []
				: [mcpGatewaySession.httpServerConfigs.orchestration]),
			...(orchestrationTools?.linearTools === undefined
				? []
				: [mcpGatewaySession.httpServerConfigs.linear]),
		];
		let acpSessionId: string | null = null;
		const configuredHome = process.env.GROK_HOME?.trim();
		const providerHome =
			configuredHome === undefined || configuredHome.length === 0
				? path.join(homedir(), ".grok")
				: path.resolve(cwd, configuredHome);
		const currentPlanFilePath = (): string | undefined => {
			if (acpSessionId === null) return undefined;
			const encodedCwd = encodeURIComponent(cwd).replace(
				/[!'()*]/g,
				(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
			);
			return path.join(
				providerHome,
				"sessions",
				encodedCwd,
				acpSessionId,
				"plan.md",
			);
		};
		let closed = false;
		/** Driver-local goal state. Grok has no `thread/goal/*` ACP surface, so we
		 *  track the goal here and forward the objective via the native `/goal`
		 *  slash command. See the goal methods on the handle below. */
		let currentGoal: ThreadGoal | null = null;
		let currentCompactionItemId: AgentItemId | null = null;
		const pendingPlanResponses = new Map<
			string,
			{ readonly rpcId: string | number }
		>();
		const pendingQuestionResponses = new Map<
			string,
			{
				readonly rpcId: string | number;
				readonly request: GrokAskUserQuestionRequest;
			}
		>();
		const eventCursor = createGrokEventCursor(providerEventCursor);
		const lifecycle = createGrokLifecycle();
		/** True once the ACP child has exited (fatal auth, crash, or normal end).
		 *  Further send() calls fail fast with a clear "session ended — start a new chat" message
		 *  instead of queuing doomed RPCs that will 5-minute timeout.
		 */
		let dead = false;
		let terminalFailure = false;
		// One-shot browser-tools hint for the model. True whenever the ACP
		// server-side context is fresh (initial connect + every respawn); the
		// next session/prompt prepends the browser tool list so the model
		// calls tools directly instead of hunting the filesystem for schemas.
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
		const translatorsBySession = new Map<string, typeof translator>();
		const subagentParentBySession = new Map<string, AgentItemId>();
		const translatorFor = (providerSessionId: string) => {
			if (providerSessionId === acpSessionId) return translator;
			const existing = translatorsBySession.get(providerSessionId);
			if (existing !== undefined) return existing;
			const created = createAcpTranslator("grok");
			translatorsBySession.set(providerSessionId, created);
			return created;
		};
		const routeSubagentEvent = (
			event: AgentEvent,
			providerSessionId: string,
		): AgentEvent => {
			const parentItemId = subagentParentBySession.get(providerSessionId);
			if (parentItemId === undefined) return event;
			switch (event._tag) {
				case "AssistantMessage":
				case "Thinking":
				case "ToolUse":
				case "ToolResult":
					return { ...event, parentItemId };
				default:
					return event;
			}
		};

		let child: ChildProcessWithoutNullStreams;
		let rl: readline.Interface;
		let connectionGeneration = 0;
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
			lifecycle.transition(
				lifecycle.current() === "start" ? "authentication" : "reconnecting",
			);
			const generation = ++connectionGeneration;
			const nextChild = spawn(
				grokPath,
				["--trust", "agent", "--no-leader", "stdio"],
				{
					cwd,
					env: {
						...process.env,
						GROK_CURSOR_MCPS_ENABLED: "0",
						...(apiKey !== null ? { GROK_CODE_XAI_API_KEY: apiKey } : {}),
					},
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			stderrTail = "";
			nextChild.stdout.setEncoding("utf-8");
			nextChild.stderr.setEncoding("utf-8");
			const nextRl = readline.createInterface({ input: nextChild.stdout });
			child = nextChild;
			rl = nextRl;
			attachListeners(nextChild, nextRl, generation);
			try {
				return await runHandshake(cursor);
			} catch (cause) {
				nextRl.close();
				nextChild.kill("SIGTERM");
				throw cause;
			}
		};

		const writeMessage = (msg: Record<string, unknown>): void => {
			if (!child.stdin.writable) return;
			const line = JSON.stringify(msg);
			if (GROK_RPC_TRACE) {
				process.stderr.write(
					`[grok.rpc.send] method=${typeof msg.method === "string" ? msg.method : "response"} id=${String(msg.id ?? "-")}\n`,
				);
			}
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
				timeoutError: () =>
					new Error(`Grok ACP ${method} timed out after ${timeoutMs}ms`),
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

		const attachListeners = (
			sourceChild: ChildProcessWithoutNullStreams,
			sourceRl: readline.Interface,
			generation: number,
		): void => {
			sourceRl.on("line", (line: string) => {
				if (generation !== connectionGeneration) return;
				if (line.trim().length === 0) return;
				if (GROK_RPC_TRACE) process.stderr.write("[grok.rpc.recv] frame\n");
				const msg = decodeJsonRpcLine(line);
				if (msg === null) {
					// Non-JSON line on stdout (e.g. a tracing log leak). Drop silently
					// — assistant text rides typed `session/update` notifications.
					return;
				}

				// Notifications and server→client requests both carry `method`.
				if (typeof msg.method === "string") {
					const wireMethod = decodeGrokWireMethod(msg.method, msg.params);
					const normalizedMethod = wireMethod.method;
					const methodParams = wireMethod.params;
					if (
						normalizedMethod === "session/update" ||
						normalizedMethod === "x.ai/session_notification" ||
						normalizedMethod === "x.ai/session/update"
					) {
						try {
							const notification = decodeGrokNotification(methodParams);
							const { update, meta } = notification;
							if (!eventCursor.shouldProcess(meta.eventId)) return;
							Queue.offerUnsafe(events, {
								_tag: "ProviderNotificationMetadata",
								...meta,
							});
							const extensionEvents = translateGrokExtensionUpdate(update).map(
								(event): AgentEvent => {
									if (event._tag !== "ContextCompaction") return event;
									if (event.status === "in_progress") {
										currentCompactionItemId = event.itemId;
										return event;
									}
									const itemId = currentCompactionItemId ?? event.itemId;
									currentCompactionItemId = null;
									return { ...event, itemId };
								},
							);
							for (const event of extensionEvents) {
								if (event._tag === "ToolUse" && event.subagent !== undefined) {
									subagentParentBySession.set(
										event.subagent.childSessionId,
										event.itemId,
									);
									translatorFor(event.subagent.childSessionId);
								}
							}
							const finishedChildSessionId =
								update.sessionUpdate === "subagent_finished" &&
								typeof update.child_session_id === "string"
									? update.child_session_id
									: null;
							const finalChildEvents =
								finishedChildSessionId === null
									? []
									: translatorFor(finishedChildSessionId)
											.flush()
											.map((event) =>
												routeSubagentEvent(event, finishedChildSessionId),
											);
							const translated = [
								...finalChildEvents,
								...extensionEvents,
								...translatorFor(notification.sessionId)
									.translate(update)
									.map((event) =>
										routeSubagentEvent(event, notification.sessionId),
									),
							];
							for (const ev of translated) {
								if (ev._tag === "GoalUpdated")
									currentGoal = ThreadGoal.make(ev.goal);
								if (ev._tag === "GoalCleared") currentGoal = null;
								Queue.offerUnsafe(events, ev);
							}
							if (finishedChildSessionId !== null) {
								translatorsBySession.delete(finishedChildSessionId);
								subagentParentBySession.delete(finishedChildSessionId);
							}
							if (update.sessionUpdate === "current_mode_update") {
								const modeId = update.currentModeId;
								if (modeId === "plan" || modeId === "default") {
									currentMode = modeId;
									Queue.offerUnsafe(events, {
										_tag: "PermissionModeChanged",
										mode: modeId,
									});
								}
							}
							if (meta.eventId !== undefined) {
								if (acpSessionId !== null)
									Queue.offerUnsafe(events, {
										_tag: "SessionCursor",
										cursor: acpSessionId,
										providerEventCursor: meta.eventId,
										strategy: "grok-session-id",
									});
							}
						} catch (cause) {
							grokDiag(
								"invalid session/update",
								cause instanceof Error ? cause.message : String(cause),
							);
						}
						return;
					}
					const dedicatedEvents = translateGrokExtensionMethod(
						normalizedMethod,
						methodParams,
					);
					if (dedicatedEvents.length > 0) {
						for (const event of dedicatedEvents)
							Queue.offerUnsafe(events, event);
						return;
					}

					// Grok swarming / collab agents + general thread/item lifecycle.
					// The ACP server emits item/started, item/completed, thread/* etc.
					// with payloads containing ThreadItem (including collabAgentToolCall)
					// and per-thread metadata (nickname, role, states). Forward the
					// params object to the translator so the new collab handling can
					// extract them. Only log at trace level to avoid noise in normal use.
					if (
						normalizedMethod.startsWith("item/") ||
						normalizedMethod.startsWith("thread/")
					) {
						if (GROK_RPC_TRACE) {
							process.stderr.write(`[grok.rpc] ${normalizedMethod}\n`);
						}
						if (methodParams !== undefined) {
							const update = {
								...(methodParams !== null && typeof methodParams === "object"
									? (methodParams as Record<string, unknown>)
									: { params: methodParams }),
								method: normalizedMethod,
							};
							const translated = translator.translate(update);
							for (const ev of translated) {
								Queue.offerUnsafe(events, ev);
							}
						}
						return;
					}

					if (msg.id !== undefined && msg.id !== null) {
						const extensionMethod = normalizedMethod;
						if (extensionMethod === "x.ai/exit_plan_mode") {
							try {
								const plan = decodePlanApprovalRequest(methodParams);
								pendingPlanResponses.set(plan.toolCallId, { rpcId: msg.id });
								lifecycle.transition("waiting-for-input");
								Queue.offerUnsafe(events, {
									_tag: "ToolUse",
									itemId: plan.toolCallId as AgentItemId,
									tool: "ExitPlanMode",
									input: { plan: plan.planContent },
								});
								Queue.offerUnsafe(events, {
									_tag: "PlanApprovalRequested",
									sessionId,
									toolCallId: plan.toolCallId as AgentItemId,
									plan: plan.planContent,
								});
							} catch {
								writeMessage({
									jsonrpc: "2.0",
									id: msg.id,
									error: {
										code: -32602,
										message: "Invalid plan approval request",
									},
								});
							}
							return;
						}
						// Server→client request (fs/*, permission prompts, etc.).
						// We now:
						//  - Log verbosely under the existing GROK_RPC_TRACE flag so the
						//    user (and we) can see exactly which tools Grok tries to call
						//    on the client ("add some logs").
						//  - For fs/* methods we reply with a clean "not implemented yet"
						//    error so the agent does not hang waiting for a response.
						//    This often makes Grok fall back to its own well-named internal
						//    tools (list_dir etc.) which our translator now renders nicely.
						const isFs = normalizedMethod.startsWith("fs/");
						if (GROK_RPC_TRACE || isFs) {
							process.stderr.write(
								`[grok.rpc] server→client request method=${normalizedMethod} id=${msg.id}\n`,
							);
						}
						if (isFs) {
							// Real FS support — the agent can now read/write files directly
							// instead of getting "Method not implemented" tool errors.
							replyToAcpRequest(
								(message) => rpc.send(message),
								msg.id,
								handleFsRequest(
									normalizedMethod,
									methodParams,
									acpHandlerContext(),
									{ planFilePath: currentPlanFilePath() },
								),
							);
							return;
						}

						if (normalizedMethod.startsWith("terminal/")) {
							replyToAcpRequest(
								(message) => rpc.send(message),
								msg.id,
								handleTerminalRequest(
									normalizedMethod,
									methodParams,
									acpHandlerContext(),
								),
							);
							return;
						}

						if (isGrokNativePermissionMethod(normalizedMethod)) {
							process.stderr.write(
								`[grok.rpc] native permission request method=${normalizedMethod} id=${msg.id}\n`,
							);
							handleGrokNativePermissionRequest(
								normalizedMethod,
								methodParams,
								acpHandlerContext(),
							)
								.then((result) => {
									if (result === null) {
										writeMessage({
											jsonrpc: "2.0",
											id: msg.id,
											error: {
												code: -32601,
												message: `Method not supported by Zuse ACP client: ${normalizedMethod}`,
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
							extensionMethod === "x.ai/ask_user_question";

						if (isQuestionMethod) {
							try {
								const questionRequest =
									decodeAskUserQuestionRequest(methodParams);
								pendingQuestionResponses.set(questionRequest.toolCallId, {
									rpcId: msg.id,
									request: questionRequest,
								});
								lifecycle.transition("waiting-for-input");
								Queue.offerUnsafe(events, {
									_tag: "UserQuestion",
									itemId: questionRequest.toolCallId as AgentItemId,
									questions: questionRequest.questions.map((question) => ({
										question: question.question,
										options: question.options.map(({ label }) => label),
										...(question.multiSelect === undefined
											? {}
											: { multiSelect: question.multiSelect }),
									})),
								});
							} catch {
								writeMessage({
									jsonrpc: "2.0",
									id: msg.id,
									error: {
										code: -32602,
										message: "Invalid user question request",
									},
								});
							}
							return;
						}

						// For everything else (permission prompts, collab callbacks, etc.)
						// we still reply with a clean error so the agent never hangs forever
						// waiting for a response that will never come.
						writeMessage({
							jsonrpc: "2.0",
							id: msg.id,
							error: {
								code: -32601,
								message: `Method not supported by Zuse ACP client: ${normalizedMethod}`,
							},
						});
						grokDiag("replied to unhandled server→client request", {
							method: normalizedMethod,
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
						const classified = classifyGrokRpcError(error);
						const rpcCode = asRecord(error)?.code;
						process.stderr.write(
							`[grok.rpc.error] method=${context.method} id=${context.id} kind=${classified} code=${typeof rpcCode === "number" ? rpcCode : "unknown"}\n`,
						);
						const errorRecord = asRecord(error);
						const errorData = asRecord(errorRecord?.data);
						return new GrokProtocolError(
							classified,
							`Grok ${context.method} failed (${classified}, code ${typeof rpcCode === "number" ? rpcCode : "unknown"}).`,
							errorRecord?.code === -32006 ||
								errorData?.code === "session_not_found" ||
								(context.method === "session/load" &&
									errorData?.code === "FS_NOT_FOUND"),
						);
					},
				});
			});

			sourceChild.stderr.on("data", (chunk: string) => {
				if (generation !== connectionGeneration) return;
				// Keep a rolling tail so errors can include the actual stderr
				// context (auth failures, version mismatch, etc.) instead of just
				// grok's generic JSON-RPC "Internal error".
				stderrTail = (stderrTail + chunk).slice(-4096);

				// Fast-path: if the agent itself reports a fatal auth failure
				// (token expired / wrong tier), kill the in-flight prompt right now
				// instead of letting the 5-minute timeout fire. This is what the
				// user meant by "not auto stopping".
			});

			sourceChild.on("error", (err) => {
				if (generation !== connectionGeneration) return;
				if (closed) return;
				dead = true;
				grokDiag("child process error event", { message: err.message });
				// Don't end the mailbox — child errors are almost always followed by a
				// `close` event, and the next send() will trigger a transparent respawn.
				// We still want the diagnostic in the logs.
			});

			sourceChild.on("close", (code, signal) => {
				sourceRl.close();
				if (generation !== connectionGeneration) return;
				dead = true;
				eventCursor.resetPending();
				const trimmedStderr = stderrTail.trim();
				const exitDetail = `Grok ACP transport closed (code ${code ?? "null"}, signal ${signal ?? "null"}).`;

				grokDiag("child process closed", {
					code,
					signal,
					stderrTailLen: trimmedStderr.length,
				});
				rpc.rejectAll(new Error(exitDetail));
				if (!closed) {
					for (const toolCallId of pendingPlanResponses.keys()) {
						Queue.offerUnsafe(events, {
							_tag: "ToolResult",
							itemId: toolCallId as AgentItemId,
							output: { outcome: "abandoned", reason: "transport_lost" },
							isError: true,
						});
					}
					for (const toolCallId of pendingQuestionResponses.keys()) {
						Queue.offerUnsafe(events, {
							_tag: "ToolResult",
							itemId: toolCallId as AgentItemId,
							output: { outcome: "cancelled", reason: "transport_lost" },
							isError: true,
						});
					}
					pendingPlanResponses.clear();
					pendingQuestionResponses.clear();
					// Keep the mailbox alive — the next send() will transparently respawn
					// the child + redo the handshake (see [[enqueuePrompt]]). Do not stop
					// the visible turn for the known Grok AuthorizationRequired noise.
					Queue.offerUnsafe(events, { _tag: "Status", status: "idle" });
					grokDiag(
						"child closed — keeping mailbox alive for transparent respawn on next send",
						{
							transportClosed: true,
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
			const init = decodeGrokInitializeResult(
				await request("initialize", {
					protocolVersion: 1,
					clientCapabilities: ACP_CLIENT_CAPABILITIES,
				}),
			);
			if (!isSupportedGrokVersion(init.agentVersion)) {
				throw new Error(
					`Grok ${init.agentVersion} is unsupported. Version ${GROK_MINIMUM_VERSION} or newer is required. Update with: ${GROK_UPDATE_COMMAND}`,
				);
			}

			grokDiag("handshake initialize returned authMethods", init.authMethods);

			const authSelection = selectGrokHandshakeAuth(
				init.authMethods,
				apiKey !== null,
			);
			if (authSelection.kind === "interactive") {
				throw new GrokProtocolError(
					"auth",
					"Authentication required. Sign in to Grok to continue.",
				);
			}
			if (authSelection.kind === "unavailable") {
				throw new Error(
					"Grok authentication is unavailable with the current configuration. Configure the required login method or set GROK_CODE_XAI_API_KEY.",
				);
			}
			const { methodId } = authSelection;
			authMethodUsed = methodId;
			grokDiag("choosing auth method", {
				methodId,
				hasApiKey: apiKey !== null,
			});

			await request("authenticate", {
				methodId,
				_meta: { headless: true },
			});
			grokDiag("authenticate succeeded", {
				methodId,
				authMethodUsed,
			});

			const acquisition = await createAcpSession({
				request,
				cwd,
				sessionId,
				providerLabel: "Grok",
				httpServers: grokMcpServers,
				resumeCursor: cursor,
				providerEventCursor: eventCursor.value(),
				shouldReplaceMissingSession: (cause) =>
					cause instanceof GrokProtocolError && cause.sessionMissing,
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
			await request("session/set_mode", {
				sessionId: acpSessionId,
				modeId: mapGrokMode(currentMode),
			});
			lifecycle.transition("idle");
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

		const enqueuePrompt = (
			text: string,
			attachmentRefs: ReadonlyArray<AttachmentRef> = [],
			reconnectAttempt = 0,
		): void => {
			const compactSnapshot = isCompactCommand(text)
				? startCompactSnapshot(null)
				: null;
			if (compactSnapshot !== null) {
				Queue.offerUnsafe(
					events,
					startCompactEvent({ providerId: "grok", snapshot: compactSnapshot }),
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
			inflight = inflight
				.then(async () => {
					if (closed) return;
					if (terminalFailure) {
						Queue.offerUnsafe(events, {
							_tag: "Error",
							message:
								"Grok session is closed after repeated transport failures. Start a new session.",
							kind: "network",
							providerId: "grok",
						});
						return;
					}
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
							const reconnectKind =
								cause instanceof GrokProtocolError ? cause.kind : "transport";
							const failureAction =
								grokSessionFailureAction(reconnectKind);
							if (failureAction !== "continue") {
								if (failureAction === "terminal") {
									terminalFailure = true;
									lifecycle.transition("error");
								}
								Queue.offerUnsafe(events, {
									_tag: "Error",
									message: reason,
									kind: reconnectKind === "auth" ? "auth" : "generic",
									providerId: "grok",
								});
								return;
							}
							if (reconnectAttempt < 2) {
								enqueuePrompt(text, attachmentRefs, reconnectAttempt + 1);
								return;
							}
							terminalFailure = true;
							lifecycle.transition("error");
							if (!closed)
								Queue.offerUnsafe(events, {
									_tag: "Error",
									message: `Grok reconnect failed: ${reason}`,
									kind: "network",
									providerId: "grok",
								});
							return;
						}
					}
					const sid = acpSessionId;
					if (sid === null) return;
					lifecycle.transition("running");
					// Prepend the browser-tools hint on the first prompt of each fresh
					// ACP context (computed here, after the potential respawn above,
					// so a respawned context gets it too). Compact turns skip it —
					// they replay a synthetic summary, not a user ask.
					const finalPromptText = promptText;
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
					grokDiag("session/prompt starting", {
						permissionMode: currentMode,
						model: input.model,
					});
					try {
						await request(
							"session/prompt",
							{
								sessionId: sid,
								prompt,
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
						const errorKind =
							cause instanceof GrokProtocolError ? cause.kind : "provider";
						const isCancellation = errorKind === "cancellation";
						const failureAction = grokSessionFailureAction(errorKind);
						const requiresUserAction = failureAction !== "continue";
						if (failureAction === "restart") {
							// The login command updates credentials out of process. Kill
							// this authenticated child so the next send re-handshakes and
							// reloads the same durable ACP conversation.
							dead = true;
							try {
								child.kill("SIGTERM");
							} catch {
								// Child may already be closing after the auth failure.
							}
						}
						if (failureAction === "terminal") terminalFailure = true;
						if (
							!isCancellation &&
							!requiresUserAction &&
							dead &&
							reconnectAttempt < 2
						) {
							enqueuePrompt(text, attachmentRefs, reconnectAttempt + 1);
							return;
						}
						if (
							failureAction === "continue" &&
							dead &&
							reconnectAttempt >= 2
						)
							terminalFailure = true;
						if (
							failureAction === "terminal" &&
							lifecycle.current() !== "error"
						)
							lifecycle.transition("error");
						if (!closed && !isCancellation) {
							Queue.offerUnsafe(events, {
								_tag: "Error",
								message: reason,
								kind:
									errorKind === "auth"
										? "auth"
										: errorKind === "transport"
											? "network"
											: "generic",
								providerId: "grok",
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
							for (const [
								providerSessionId,
								childTranslator,
							] of translatorsBySession) {
								for (const ev of childTranslator.flush()) {
									Queue.offerUnsafe(
										events,
										routeSubagentEvent(ev, providerSessionId),
									);
								}
							}
							Queue.offerUnsafe(events, { _tag: "Status", status: "idle" });
							if (lifecycle.current() === "running")
								lifecycle.transition("idle");
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
					enqueuePrompt(text, attachmentRefs ?? []);
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
					for (const { rpcId } of pendingPlanResponses.values()) {
						writeMessage({
							jsonrpc: "2.0",
							id: rpcId,
							result: { outcome: "abandoned" },
						});
					}
					for (const { rpcId } of pendingQuestionResponses.values()) {
						writeMessage({
							jsonrpc: "2.0",
							id: rpcId,
							result: { outcome: "cancelled" },
						});
					}
					pendingPlanResponses.clear();
					pendingQuestionResponses.clear();
					if (lifecycle.current() !== "closed") lifecycle.transition("closed");
					rpc.rejectAll(new Error("Grok session closed"));
					try {
						child.stdin.end();
					} catch {
						// ignore — stdin may already be closed by the child
					}
					child.kill("SIGTERM");
					rl.close();
					yield* Effect.promise(() => mcpGatewaySession.close());
					yield* Queue.end(events);
				}),
			setPermissionMode: (mode) =>
				Effect.promise(async () => {
					if (mode === currentMode) return;
					if (acpSessionId === null) return;
					await request("session/set_mode", {
						sessionId: acpSessionId,
						modeId: mapGrokMode(mode),
					});
				}),
			answerQuestion: (itemId, answers) =>
				Effect.sync(() => {
					const pending = pendingQuestionResponses.get(itemId);
					if (pending === undefined)
						throw new Error(`No pending Grok question ${itemId}.`);
					const hasAnswer = answers.some(
						(answer) =>
							answer.selected.length > 0 ||
							(answer.other !== undefined && answer.other.trim().length > 0),
					);
					if (!hasAnswer) {
						writeMessage({
							jsonrpc: "2.0",
							id: pending.rpcId,
							result: { outcome: "cancelled" },
						});
						pendingQuestionResponses.delete(itemId);
						lifecycle.transition("running");
						return;
					}
					const responseAnswers: Record<string, ReadonlyArray<string>> = {};
					const annotations: Record<string, { notes: string }> = {};
					for (const answer of answers) {
						const question = pending.request.questions[answer.questionIndex];
						if (question === undefined) continue;
						const selected = answer.selected.flatMap((index) => {
							const option = question.options[index];
							return option === undefined ? [] : [option.label];
						});
						if (answer.other !== undefined && answer.other.trim().length > 0) {
							selected.push("Other");
							annotations[question.question] = { notes: answer.other.trim() };
						}
						responseAnswers[question.question] = selected;
					}
					writeMessage({
						jsonrpc: "2.0",
						id: pending.rpcId,
						result: {
							outcome: "accepted",
							answers: responseAnswers,
							...(Object.keys(annotations).length === 0 ? {} : { annotations }),
						},
					});
					pendingQuestionResponses.delete(itemId);
					lifecycle.transition("running");
				}),
			respondToPlan: (toolCallId, outcome, feedback) =>
				Effect.sync(() => {
					const pending = pendingPlanResponses.get(toolCallId);
					if (pending === undefined)
						throw new Error(`No pending Grok plan approval ${toolCallId}.`);
					writeMessage({
						jsonrpc: "2.0",
						id: pending.rpcId,
						result: {
							outcome,
							...(feedback === undefined || feedback.trim().length === 0
								? {}
								: { feedback: feedback.trim() }),
						},
					});
					pendingPlanResponses.delete(toolCallId);
					lifecycle.transition("running");
				}),
			acknowledgeProviderEventCursor: (cursor) =>
				Effect.sync(() => eventCursor.commit(cursor)),
			releaseProviderEventCursor: (cursor) =>
				Effect.sync(() => eventCursor.release(cursor)),
			updateMcpServers: (servers) =>
				Effect.promise(async () => {
					if (acpSessionId === null) return;
					await request("x.ai/session/update_mcp_servers", {
						sessionId: acpSessionId,
						mcpServers: servers,
					});
				}),
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
					const previousStatus = currentGoal?.status;
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
					if (currentGoal === null && objective.length > 0) {
						const budget = goal.tokenBudget;
						enqueuePrompt(
							`/goal ${objective}${budget === null ? "" : ` --budget ${budget}`}`,
						);
					} else if (status === "paused" && previousStatus !== "paused") {
						enqueuePrompt("/goal pause");
					} else if (status === "active" && previousStatus === "paused") {
						enqueuePrompt("/goal resume");
					}
					return goal;
				}),
			clearGoal: () =>
				Effect.sync(() => {
					enqueuePrompt("/goal clear");
				}),
		};
		return handle;
	});
