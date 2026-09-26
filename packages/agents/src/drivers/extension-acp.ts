import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { AcpConnection } from "@zuse/acp/connection";
import { killAcpProcess } from "@zuse/acp/process";
import type { AgentEvent, AgentItemId } from "@zuse/contracts";
import type {
	ExtensionAcpProviderDefinition,
	ExtensionProviderAdapter,
	ExtensionProviderDescriptor,
	ExtensionProviderSessionInput,
} from "@zuse/extension-sdk";
import { Schema } from "effect";
import { createAcpTranslator } from "./acp/translate.ts";

const Initialize = Schema.Struct({
	protocolVersion: Schema.Number,
	agentCapabilities: Schema.optional(
		Schema.Struct({ loadSession: Schema.optional(Schema.Boolean) }),
	),
});
const Created = Schema.Struct({ sessionId: Schema.String });
const Permission = Schema.Struct({
	sessionId: Schema.String,
	toolCall: Schema.Struct({
		title: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))),
		rawInput: Schema.optional(Schema.Unknown),
	}),
	options: Schema.Array(
		Schema.Struct({
			optionId: Schema.String,
			name: Schema.String.check(Schema.isMaxLength(256)),
			kind: Schema.String,
		}),
	).check(Schema.isMaxLength(32)),
});
const Answers = Schema.Array(
	Schema.Struct({
		questionIndex: Schema.Number,
		selected: Schema.Array(Schema.Number),
		other: Schema.optional(Schema.String),
	}),
);
const Update = Schema.Struct({
	sessionId: Schema.String,
	update: Schema.Unknown,
});
interface PendingPermission {
	readonly options: readonly { optionId: string; name: string; kind: string }[];
	readonly respond: (value: unknown) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}
interface Session {
	readonly input: ExtensionProviderSessionInput;
	readonly child: ChildProcessWithoutNullStreams;
	readonly connection: AcpConnection;
	translator: ReturnType<typeof createAcpTranslator>;
	readonly permissions: Map<string, PendingPermission>;
	cursor: string;
	ready: boolean;
	closed: boolean;
	running: boolean;
	mode: ExtensionProviderSessionInput["permissionMode"];
	turn: Promise<void> | null;
}
/** One process per conversation, shared ACP translation, no provider-specific UI. */
export function createExtensionAcpProvider(
	definition: ExtensionAcpProviderDefinition,
	emit: (sessionId: string, event: AgentEvent) => void,
	processLifecycle?: { started(pid: number): void; stopped(pid: number): void },
): {
	descriptor: ExtensionProviderDescriptor;
	adapter: ExtensionProviderAdapter;
	dispose: () => Promise<void>;
} {
	if (
		!Array.isArray(definition.command) ||
		!definition.command.length ||
		definition.command.length > 128 ||
		definition.command.some(
			(v) => typeof v !== "string" || v.includes("\0") || v.length > 8192,
		) ||
		!definition.command[0].trim()
	)
		throw new Error(
			"ACP command must be a non-empty executable and argument array.",
		);
	if (
		definition.env &&
		(Object.keys(definition.env).length > 128 ||
			Object.entries(definition.env).some(
				([k, v]) =>
					!k ||
					k.includes("=") ||
					k.includes("\0") ||
					typeof v !== "string" ||
					v.includes("\0") ||
					v.length > 32768,
			))
	)
		throw new Error("Invalid ACP environment.");
	const startupTimeout = definition.startupTimeoutMs ?? 15000;
	if (
		!Number.isInteger(startupTimeout) ||
		startupTimeout < 100 ||
		startupTimeout > 25000
	)
		throw new Error(
			"ACP startup deadline must be between 100 and 25000 milliseconds.",
		);
	const sessions = new Map<string, Session>();
	let disposed = false;
	const output = (s: Session, event: AgentEvent) => {
		if (!s.closed) emit(s.input.sessionId, event);
	};
	const releaseQuestions = (s: Session) => {
		for (const [id, pending] of s.permissions) {
			clearTimeout(pending.timer);
			pending.respond({ outcome: { outcome: "cancelled" } });
			output(s, {
				_tag: "UserQuestionResolved",
				itemId: id as AgentItemId,
				resolution: "cancelled",
			});
		}
		s.permissions.clear();
	};
	const terminate = async (s: Session) => {
		if (s.closed) return;
		releaseQuestions(s);
		s.closed = true;
		s.translator.flush();
		s.connection.close();
		if (sessions.get(s.input.sessionId) === s)
			sessions.delete(s.input.sessionId);
		const pid = s.child.pid;
		if (!pid) return;
		try {
			if (s.child.exitCode === null && s.child.signalCode === null) {
				await new Promise<void>((resolve) => {
					const done = () => {
						clearTimeout(timer);
						s.child.off("exit", done);
						resolve();
					};
					const timer = setTimeout(done, 1000);
					s.child.once("exit", done);
					killAcpProcess(pid, "SIGTERM");
				});
			}
		} finally {
			// A parent exiting does not imply that its descendants exited.
			killAcpProcess(pid);
			processLifecycle?.stopped(pid);
		}
	};
	const fail = (s: Session, cause: unknown) => {
		if (s.closed) return;
		if (s.ready) {
			for (const event of s.translator.flush()) output(s, event);
			output(s, {
				_tag: "Error",
				message:
					cause instanceof Error ? cause.message : "ACP agent disconnected.",
			});
			output(s, { _tag: "Status", status: "error" });
		}
		void terminate(s);
	};
	const requireSession = (id: string) => {
		const s = sessions.get(id);
		if (!s || s.closed || !s.ready)
			throw new Error(
				"ACP session is unavailable. Resume the conversation to reconnect.",
			);
		return s;
	};
	const setMode = async (s: Session, mode: Session["mode"]) => {
		const modeId = definition.modes?.[mode];
		if (!modeId) {
			if (mode !== "default" || s.mode !== "default")
				throw new Error(
					`This adapter does not declare an ACP mode for ${mode}.`,
				);
			return;
		}
		await s.connection.request(
			"session/set_mode",
			{ sessionId: s.cursor, modeId },
			Schema.Unknown,
			{ timeoutMs: startupTimeout },
		);
		s.mode = mode;
	};
	const descriptor: ExtensionProviderDescriptor = {
		id: definition.id,
		displayName: definition.displayName,
		authentication: { kind: "none" },
		capabilities: ["answerQuestion", "resume"],
		models: definition.models?.length
			? definition.models
			: [
					{
						id: "default",
						label: "Agent default",
						defaultModel: true,
						defaultVisible: true,
						supportsPlanMode: Boolean(definition.modes?.plan),
					},
				],
	};
	const adapter: ExtensionProviderAdapter = {
		async probe() {
			const binary = definition.command[0];
			const paths =
				isAbsolute(binary) || binary.includes("/") || binary.includes("\\")
					? [binary]
					: (definition.env?.PATH ?? process.env.PATH ?? "")
							.split(delimiter)
							.filter(Boolean)
							.flatMap((dir) =>
								process.platform === "win32"
									? [join(dir, binary), join(dir, `${binary}.exe`)]
									: [join(dir, binary)],
							);
			for (const path of paths) {
				try {
					await access(path, constants.X_OK);
					return {
						available: true,
						authenticated: true,
						message:
							definition.loginHint ?? "Uses the agent's existing CLI login.",
					};
				} catch {}
			}
			return {
				available: false,
				authenticated: false,
				message:
					`Install ${definition.displayName} and make its command available on PATH. ${definition.loginHint ?? ""}`.trim(),
			};
		},
		async start(input) {
			if (disposed) throw new Error("ACP provider is disposed.");
			if (sessions.has(input.sessionId))
				throw new Error("ACP session already exists.");
			if (sessions.size >= 64) throw new Error("Too many ACP sessions.");
			if (input.forkFromResume)
				throw new Error("This ACP adapter does not support forking.");
			const child = spawn(definition.command[0], definition.command.slice(1), {
				cwd: input.cwd,
				env: { ...process.env, ...definition.env },
				stdio: "pipe",
				shell: false,
				detached: process.platform !== "win32",
				windowsHide: true,
			});
			if (child.pid) processLifecycle?.started(child.pid);
			// Drain stderr without exposing agent credentials or private protocol bodies to logs.
			child.stderr.resume();
			let state: Session;
			const connection = new AcpConnection(child.stdout, child.stdin, {
				onClose: (cause) => {
					if (state) fail(state, cause);
				},
				onRequest: (request, respond, reject) => {
					if (request.method !== "session/request_permission") {
						reject(
							-32601,
							"Client filesystem and terminal operations are not supported by this adapter.",
						);
						return;
					}
					try {
						const permission = Schema.decodeUnknownSync(Permission)(
							request.params,
						);
						if (
							!state?.ready ||
							permission.sessionId !== state.cursor ||
							!state.running ||
							state.mode === "plan"
						) {
							respond({ outcome: { outcome: "cancelled" } });
							return;
						}
						// Persistent allow rules remain native-agent-owned; only explicit one-time choices are offered.
						const options = permission.options.filter(
							(o) => o.kind === "allow_once" || o.kind === "reject_once",
						);
						if (!options.some((o) => o.kind === "reject_once"))
							options.push({ optionId: "", name: "Deny", kind: "zuse_cancel" });
						if (
							!options.some((o) => o.kind === "allow_once") ||
							state.permissions.size >= 16
						) {
							respond({ outcome: { outcome: "cancelled" } });
							return;
						}
						const id = `acp-permission-${crypto.randomUUID()}`;
						const timer = setTimeout(() => {
							const pending = state.permissions.get(id);
							if (!pending) return;
							state.permissions.delete(id);
							pending.respond({ outcome: { outcome: "cancelled" } });
							output(state, {
								_tag: "UserQuestionResolved",
								itemId: id as AgentItemId,
								resolution: "timed-out",
							});
						}, 120000);
						state.permissions.set(id, { options, respond, timer });
						output(state, {
							_tag: "UserQuestion",
							itemId: id as AgentItemId,
							questions: [
								{
									question: `${permission.toolCall.title ?? "Allow this agent operation?"}${permission.toolCall.rawInput === undefined ? "" : `\n${JSON.stringify(permission.toolCall.rawInput).slice(0, 4000)}`}`,
									options: options.map((o) => o.name),
									multiSelect: false,
								},
							],
						});
					} catch {
						reject(-32602, "Invalid ACP permission request.");
					}
				},
			});
			state = {
				input,
				child,
				connection,
				translator: createAcpTranslator("generic", {
					onCheckpoint: (events) => {
						for (const event of events) output(state, event);
					},
				}),
				permissions: new Map(),
				cursor: "",
				ready: false,
				closed: false,
				running: false,
				mode: "default",
				turn: null,
			};
			sessions.set(input.sessionId, state);
			child.once("error", (cause) => connection.close(cause));
			child.once("exit", (code, signal) =>
				connection.close(
					new Error(
						`${definition.displayName} exited (${signal ?? code ?? "unknown"}). Resume to reconnect.`,
					),
				),
			);
			connection.subscribe((notification) => {
				if (notification.method !== "session/update" || state.closed) return;
				const update = Schema.decodeUnknownSync(Update)(notification.params);
				if (update.sessionId !== state.cursor || !state.running) return;
				for (const event of state.translator.translate(update.update))
					output(state, event);
			});
			const timer = setTimeout(
				() => connection.close(new Error("ACP startup timed out.")),
				startupTimeout,
			);
			try {
				const init = await connection.request(
					"initialize",
					{
						protocolVersion: 1,
						clientInfo: { name: "zuse", version: "1.0.0" },
						clientCapabilities: {
							fs: { readTextFile: false, writeTextFile: false },
							terminal: false,
						},
					},
					Initialize,
					{ timeoutMs: startupTimeout },
				);
				if (init.protocolVersion !== 1)
					throw new Error(
						`Unsupported ACP protocol version: ${init.protocolVersion}`,
					);
				if (input.resumeCursor && !init.agentCapabilities?.loadSession)
					throw new Error(
						"This agent cannot resume ACP sessions. Start a new conversation.",
					);
				if (input.resumeCursor) {
					await connection.request(
						"session/load",
						{ sessionId: input.resumeCursor, cwd: input.cwd, mcpServers: [] },
						Schema.Unknown,
						{ timeoutMs: startupTimeout },
					);
					state.cursor = input.resumeCursor;
				} else
					state.cursor = (
						await connection.request(
							"session/new",
							{ cwd: input.cwd, mcpServers: [] },
							Created,
							{ timeoutMs: startupTimeout },
						)
					).sessionId;
				if (input.model && input.model !== "default")
					await connection.request(
						"session/set_model",
						{ sessionId: state.cursor, modelId: input.model },
						Schema.Unknown,
						{ timeoutMs: startupTimeout },
					);
				await setMode(state, input.permissionMode);
				if (state.closed) throw new Error("ACP agent closed during startup.");
				state.ready = true;
				output(state, {
					_tag: "SessionCursor",
					cursor: state.cursor,
					strategy: "acp-session-id",
				});
				output(state, { _tag: "Status", status: "idle" });
			} catch (cause) {
				await terminate(state);
				throw new Error(
					`${definition.displayName}: ${cause instanceof Error ? cause.message : "ACP startup failed"}${definition.loginHint ? ` ${definition.loginHint}` : ""}`,
				);
			} finally {
				clearTimeout(timer);
			}
		},
		async send(id, text) {
			const s = requireSession(id);
			if (s.running)
				throw new Error("This ACP session is already processing a prompt.");
			if (Buffer.byteLength(text) > 1024 * 1024)
				throw new Error("ACP prompt exceeds 1 MiB.");
			s.translator.flush();
			s.translator = createAcpTranslator("generic", {
				onCheckpoint: (events) => {
					for (const event of events) output(s, event);
				},
			});
			s.running = true;
			output(s, { _tag: "Status", status: "running" });
			s.turn = s.connection
				.request(
					"session/prompt",
					{ sessionId: s.cursor, prompt: [{ type: "text", text }] },
					Schema.Unknown,
					{ timeoutMs: null },
				)
				.then(
					() => {},
					(cause) => {
						if (!s.closed)
							output(s, {
								_tag: "Error",
								message:
									cause instanceof Error ? cause.message : "ACP prompt failed.",
							});
					},
				)
				.finally(() => {
					releaseQuestions(s);
					for (const event of s.translator.flush()) output(s, event);
					s.running = false;
					s.turn = null;
					output(s, { _tag: "Status", status: "idle" });
				});
		},
		async interrupt(id) {
			const s = requireSession(id);
			releaseQuestions(s);
			if (!s.running) return;
			s.connection.notify("session/cancel", { sessionId: s.cursor });
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				s.turn,
				new Promise<void>((resolve) => {
					timer = setTimeout(() => {
						fail(
							s,
							new Error(
								"ACP agent did not acknowledge cancellation. Resume to reconnect.",
							),
						);
						resolve();
					}, 2000);
				}),
			]);
			if (timer) clearTimeout(timer);
		},
		async setPermissionMode(id, mode) {
			const s = requireSession(id);
			if (s.running)
				throw new Error("Wait for the current turn before changing modes.");
			await setMode(s, mode);
		},
		async answerQuestion(id, itemId, value) {
			const s = requireSession(id),
				pending = s.permissions.get(itemId);
			if (!pending)
				throw new Error("ACP permission request expired or was cancelled.");
			const answers = Schema.decodeUnknownSync(Answers)(value),
				answer = answers.find((a) => a.questionIndex === 0);
			const index =
				answer?.selected.length === 1 ? answer.selected[0] : undefined;
			const option =
				index !== undefined && Number.isInteger(index)
					? pending.options[index]
					: undefined;
			if (!option || answer?.other?.trim())
				throw new Error("Choose one of the displayed permission options.");
			clearTimeout(pending.timer);
			s.permissions.delete(itemId);
			pending.respond({
				outcome:
					option.kind === "zuse_cancel"
						? { outcome: "cancelled" }
						: { outcome: "selected", optionId: option.optionId },
			});
		},
		async close(id) {
			const s = sessions.get(id);
			if (s) await terminate(s);
		},
	};
	return {
		descriptor,
		adapter,
		dispose: async () => {
			disposed = true;
			await Promise.all([...sessions.values()].map(terminate));
		},
	};
}
