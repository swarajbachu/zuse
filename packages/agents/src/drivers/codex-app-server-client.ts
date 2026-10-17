import type { ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { ClientRequest } from "@zuse/agents/codex-generated/ClientRequest";
import type { InitializeResponse } from "@zuse/agents/codex-generated/InitializeResponse";
import type { ServerNotification } from "@zuse/agents/codex-generated/ServerNotification";
import type { ServerRequest } from "@zuse/agents/codex-generated/ServerRequest";
import { spawn } from "@zuse/utils/spawn-command";
import {
	stopProviderProcess,
	watchProviderProcess,
} from "../kernel/provider-process.ts";
import { reportCodexStderr } from "./codex-stderr-reporter.ts";
import { DEVICE_COMMAND_TOOL_TIMEOUT_SECONDS } from "./device-command-tools.ts";

type RequestId = number;

type Pending = {
	readonly resolve: (value: unknown) => void;
	readonly reject: (reason: Error) => void;
};

type ServerRequestHandler = (
	request: ServerRequest,
	respond: (result: unknown) => void,
) => void;

type NotificationHandler = (notification: ServerNotification) => void;
type UnexpectedTerminationHandler = (error: Error) => void;

const STDERR_TAIL_LIMIT_BYTES = 4 * 1024;

export interface CodexChatgptAuthTokens {
	readonly accessToken: string;
	readonly chatgptAccountId: string;
	readonly chatgptPlanType: string | null;
	readonly expiresAt: number;
}

export interface CodexExternalAuthProvider {
	readonly getTokens: (input: {
		readonly reason: "initial" | "proactive" | "unauthorized";
		readonly previousChatgptAccountId?: string;
	}) => Promise<CodexChatgptAuthTokens>;
	readonly onDeliveryFailure?: (input: {
		readonly consumerId?: string;
		readonly reason: string;
	}) => void;
}

let defaultExternalAuthProvider: CodexExternalAuthProvider | null = null;

/** One cloud runtime process owns one workspace, so every launch shares this. */
export const setDefaultCodexExternalAuthProvider = (
	provider: CodexExternalAuthProvider | null,
): void => {
	defaultExternalAuthProvider = provider;
};

export const CODEX_EXTERNAL_AUTH_CALLBACK_DEADLINE_MS = 8_000;

export const beforeCodexExternalAuthDeadline = async <A>(
	operation: Promise<A>,
): Promise<A> => {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("codex-auth-reconnecting")),
					CODEX_EXTERNAL_AUTH_CALLBACK_DEADLINE_MS,
				);
				timer.unref();
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
};

/**
 * Lets other Codex-backed capabilities in the same workspace runtime reuse the
 * brokered, memory-only access grant without reaching into native auth files.
 */
export const getDefaultCodexExternalAuthTokens = async (
	reason: "proactive" | "unauthorized",
): Promise<CodexChatgptAuthTokens | null> => {
	if (defaultExternalAuthProvider === null) return null;
	return beforeCodexExternalAuthDeadline(
		defaultExternalAuthProvider.getTokens({ reason }),
	);
};

type CodexGoalRequestMethod =
	| "thread/goal/get"
	| "thread/goal/set"
	| "thread/goal/clear";

type CodexExperimentalRequestMethod = "collaborationMode/list";

export type CodexAppMcpLaunchConfig = (
	| {
			readonly transport: "http";
			readonly url: string;
			readonly bearerTokenEnvVar: string;
	  }
	| {
			readonly transport: "stdio";
			readonly command: string;
			readonly args: ReadonlyArray<string>;
			readonly env: Readonly<Record<string, string>>;
	  }
) & {
	/**
	 * Native `[mcp_servers]` names to switch off for this process. Must only
	 * list names Codex defines regardless of cwd (see `codex-native-mcp.ts`).
	 */
	readonly disabledNativeServers?: ReadonlyArray<string>;
};

const CODEX_NATIVE_MCP_FEATURE_OVERRIDES = [
	"-c",
	"features.apps=false",
	"-c",
	"features.skill_mcp_dependency_install=false",
] as const;

const disabledNativeServersOverride = (
	names: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> =>
	names === undefined || names.length === 0
		? []
		: [
				"-c",
				`mcp_servers={${names
					.map((name) => `${JSON.stringify(name)}={enabled=false}`)
					.join(",")}}`,
			];

export const codexAppServerLaunchArgs = (
	mcp?: CodexAppMcpLaunchConfig,
): ReadonlyArray<string> => [
	"app-server",
	"--listen",
	"stdio://",
	...(mcp === undefined
		? []
		: [
				...CODEX_NATIVE_MCP_FEATURE_OVERRIDES,
				...disabledNativeServersOverride(mcp.disabledNativeServers),

				"-c",
				`mcp_servers.zuse.tool_timeout_sec=${DEVICE_COMMAND_TOOL_TIMEOUT_SECONDS}`,
			]),
	...(mcp === undefined
		? []
		: mcp.transport === "http"
			? [
					"-c",
					`mcp_servers.zuse.url=${JSON.stringify(mcp.url)}`,
					"-c",
					`mcp_servers.zuse.bearer_token_env_var=${JSON.stringify(
						mcp.bearerTokenEnvVar,
					)}`,
				]
			: [
					"-c",
					`mcp_servers.zuse.command=${JSON.stringify(mcp.command)}`,
					"-c",
					`mcp_servers.zuse.args=${JSON.stringify(mcp.args)}`,
					...Object.entries(mcp.env).flatMap(([name, value]) => [
						"-c",
						`mcp_servers.zuse.env.${name}=${JSON.stringify(value)}`,
					]),
				]),
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const errorMessage = (error: unknown): string => {
	if (isRecord(error) && typeof error.message === "string")
		return error.message;
	return JSON.stringify(error);
};

export class CodexAppServerRequestError extends Error {
	readonly code: number | null;
	readonly data: unknown;

	constructor(error: unknown) {
		super(errorMessage(error));
		this.name = "CodexAppServerRequestError";
		this.code =
			isRecord(error) && typeof error.code === "number" ? error.code : null;
		this.data = isRecord(error) ? error.data : undefined;
	}
}

export class CodexAppServerClient {
	private nextId: RequestId = 1;
	private readonly pending = new Map<RequestId, Pending>();
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly rl: readline.Interface;
	private closed = false;
	private eofTimer: ReturnType<typeof setTimeout> | undefined;
	private stderrTail = Buffer.alloc(0);

	initializeResponse: InitializeResponse;

	private constructor(
		child: ChildProcessWithoutNullStreams,
		rl: readline.Interface,
		initializeResponse: InitializeResponse,
		readonly onNotification: NotificationHandler,
		readonly onServerRequest: ServerRequestHandler,
		readonly onUnexpectedTermination?: UnexpectedTerminationHandler,
	) {
		this.child = child;
		this.rl = rl;
		this.initializeResponse = initializeResponse;
	}

	static async start(options: {
		readonly codexPath: string | null;
		/** Delivered over stdin using an in-memory credential store. */
		readonly apiKey?: string | null;
		readonly env?: NodeJS.ProcessEnv;
		readonly mcp?: CodexAppMcpLaunchConfig;
		readonly startupTimeoutMs?: number;
		readonly startupSignal?: AbortSignal;
		readonly onStderr?: (text: string) => void;
		readonly onNotification: NotificationHandler;
		readonly onServerRequest: ServerRequestHandler;
		readonly externalAuthProvider?: CodexExternalAuthProvider | null;
		/** Session identity used only to resume a proven auth-blocked consumer. */
		readonly externalAuthConsumerId?: string;
		readonly onUnexpectedTermination?: UnexpectedTerminationHandler;
	}): Promise<CodexAppServerClient> {
		options.startupSignal?.throwIfAborted();
		const externalAuthProvider =
			options.externalAuthProvider === undefined
				? defaultExternalAuthProvider
				: options.externalAuthProvider;
		const apiKey = externalAuthProvider === null ? options.apiKey : null;
		const hasApiKey =
			apiKey !== null && apiKey !== undefined && apiKey.length > 0;
		const handleServerRequest: ServerRequestHandler = (request, respond) => {
			if (
				externalAuthProvider !== null &&
				request.method === "account/chatgptAuthTokens/refresh"
			) {
				void beforeCodexExternalAuthDeadline(
					externalAuthProvider.getTokens({
						reason: "unauthorized",
						...(request.params.previousAccountId === null ||
						request.params.previousAccountId === undefined
							? {}
							: {
									previousChatgptAccountId: request.params.previousAccountId,
								}),
					}),
				)
					.then((tokens) =>
						respond({
							accessToken: tokens.accessToken,
							chatgptAccountId: tokens.chatgptAccountId,
							chatgptPlanType: tokens.chatgptPlanType,
						}),
					)
					.catch((cause) => {
						externalAuthProvider.onDeliveryFailure?.({
							...(options.externalAuthConsumerId === undefined
								? {}
								: { consumerId: options.externalAuthConsumerId }),
							reason:
								cause instanceof Error
									? cause.message
									: "codex-auth-reconnecting",
						});
						respond(null);
					});
				return;
			}
			options.onServerRequest(request, respond);
		};
		const child = spawn(
			options.codexPath ?? "codex",
			[
				...codexAppServerLaunchArgs(options.mcp),
				...(hasApiKey ? ["-c", 'cli_auth_credentials_store="ephemeral"'] : []),
			],
			{ env: options.env, detached: process.platform !== "win32" },
		);
		watchProviderProcess(child);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");

		const rl = readline.createInterface({
			input: child.stdout,
			crlfDelay: Infinity,
		});

		const bootstrap = new CodexAppServerClient(
			child,
			rl,
			{
				userAgent: "",
				codexHome: "",
				platformFamily: "",
				platformOs: "",
			},
			options.onNotification,
			handleServerRequest,
			options.onUnexpectedTermination,
		);
		rl.on("line", (line) => bootstrap.handleLine(line));
		rl.once("close", () => {
			if (bootstrap.closed) return;

			bootstrap.eofTimer = setTimeout(() => {
				bootstrap.handleUnexpectedTermination(
					new Error("Codex app-server output closed unexpectedly"),
				);
			}, 50);
			bootstrap.eofTimer.unref();
		});
		child.stdin.on("error", (error) =>
			bootstrap.handleUnexpectedTermination(error),
		);
		child.stdout.on("error", (error) =>
			bootstrap.handleUnexpectedTermination(error),
		);
		child.stderr.on("data", (chunk) => {
			bootstrap.appendStderr(String(chunk));
			const text = String(chunk).trim();
			if (text.length === 0) return;
			if (options.onStderr !== undefined) options.onStderr(text);
			else reportCodexStderr(text);
		});

		child.once("error", (err) => bootstrap.handleUnexpectedTermination(err));
		child.once("close", (code, signal) => {
			bootstrap.handleUnexpectedTermination(
				new Error(
					`Codex app-server exited with ${signal ?? `code ${code ?? 0}`}`,
				),
			);
		});

		let rejectStartup: ((cause: unknown) => void) | undefined;
		const abortStartup = () => {
			rejectStartup?.(options.startupSignal?.reason);
			void bootstrap.close();
		};
		options.startupSignal?.addEventListener("abort", abortStartup, {
			once: true,
		});
		let timer: NodeJS.Timeout | undefined;
		try {
			options.startupSignal?.throwIfAborted();
			const handshake = async () => {
				const init = await bootstrap.request<InitializeResponse>("initialize", {
					clientInfo: { name: "zuse", version: "0.0.0" },
					capabilities: { experimentalApi: true },
				});
				bootstrap.initializeResponse = init;
				if (externalAuthProvider !== null) {
					let tokens: CodexChatgptAuthTokens;
					try {
						tokens = await beforeCodexExternalAuthDeadline(
							externalAuthProvider.getTokens({ reason: "initial" }),
						);
					} catch (cause) {
						externalAuthProvider.onDeliveryFailure?.({
							...(options.externalAuthConsumerId === undefined
								? {}
								: { consumerId: options.externalAuthConsumerId }),
							reason:
								cause instanceof Error
									? cause.message
									: "codex-auth-reconnecting",
						});
						throw cause;
					}
					await bootstrap.request("account/login/start", {
						type: "chatgptAuthTokens",
						accessToken: tokens.accessToken,
						chatgptAccountId: tokens.chatgptAccountId,
						chatgptPlanType: tokens.chatgptPlanType,
					});
				}
				if (hasApiKey) {
					await bootstrap.request("account/login/start", {
						type: "apiKey",
						apiKey,
					});
				}
				return bootstrap;
			};
			return await Promise.race([
				handshake(),
				new Promise<never>((_resolve, reject) => {
					rejectStartup = reject;
					if (options.startupSignal?.aborted) {
						reject(options.startupSignal.reason);
						return;
					}
					if (options.startupTimeoutMs !== undefined) {
						timer = setTimeout(
							() => reject(new Error("Codex app-server startup timed out")),
							options.startupTimeoutMs,
						);
					}
				}),
			]);
		} catch (cause) {
			await bootstrap.close();
			throw cause;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			options.startupSignal?.removeEventListener("abort", abortStartup);
		}
	}

	request<T>(
		method:
			| ClientRequest["method"]
			| CodexGoalRequestMethod
			| CodexExperimentalRequestMethod,
		params: unknown,
		options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
	): Promise<T> {
		const signal = options?.signal;
		if (signal?.aborted) return Promise.reject(signal.reason);
		if (this.closed)
			return Promise.reject(new Error("Codex app-server is closed"));
		const id = this.nextId++;
		const message =
			params === undefined ? { id, method } : { id, method, params };
		return new Promise<T>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				if (timer !== undefined) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.pending.delete(id);
			};
			const fail = (error: unknown) => {
				cleanup();
				reject(error);
			};
			const onAbort = () => fail(signal?.reason);
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, {
				resolve: (value) => {
					cleanup();
					resolve(value as T);
				},
				reject: fail,
			});
			if (options?.timeoutMs !== undefined)
				timer = setTimeout(
					() => fail(new Error("Codex app-server request timed out")),
					options.timeoutMs,
				);
			this.child.stdin.write(`${JSON.stringify(message)}\n`, (err) => {
				if (err) fail(err);
			});
		});
	}

	respond(id: RequestId, result: unknown): void {
		if (this.closed) return;
		this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
	}

	close(): Promise<void> {
		if (!this.closed) {
			this.closed = true;
			clearTimeout(this.eofTimer);
			this.rl.close();
			this.rejectPending(new Error("Codex app-server is closed"));
		}
		return stopProviderProcess(this.child, { processGroup: true });
	}

	private appendStderr(text: string): void {
		const incoming = Buffer.from(text, "utf8");
		if (incoming.length >= STDERR_TAIL_LIMIT_BYTES) {
			this.stderrTail = Buffer.from(
				incoming.subarray(incoming.length - STDERR_TAIL_LIMIT_BYTES),
			);
			return;
		}
		const retained = this.stderrTail.subarray(
			Math.max(
				0,
				this.stderrTail.length - (STDERR_TAIL_LIMIT_BYTES - incoming.length),
			),
		);
		this.stderrTail = Buffer.concat([retained, incoming]);
	}

	private handleUnexpectedTermination(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.eofTimer);
		this.rl.close();
		void stopProviderProcess(this.child, { processGroup: true });
		const stderr = this.stderrTail.toString("utf8").trim();
		const reason =
			stderr.length === 0
				? error
				: new Error(`${error.message}\nCodex stderr (tail):\n${stderr}`, {
						cause: error,
					});
		this.rejectPending(reason);
		try {
			this.onUnexpectedTermination?.(reason);
		} catch (cause) {
			reportCodexStderr(
				`unexpected termination handler failed: ${cause instanceof Error ? cause.message : String(cause)}`,
			);
		}
	}

	private rejectPending(reason: Error): void {
		for (const pending of this.pending.values()) pending.reject(reason);
		this.pending.clear();
	}

	private handleLine(line: string): void {
		if (line.trim().length === 0) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			reportCodexStderr(`non-json stdout: ${line}`);
			return;
		}
		if (!isRecord(parsed)) return;

		const id = typeof parsed.id === "number" ? parsed.id : null;
		const method = typeof parsed.method === "string" ? parsed.method : null;
		if (id !== null && method !== null) {
			this.onServerRequest(parsed as ServerRequest, (result) =>
				this.respond(id, result),
			);
			return;
		}
		if (id !== null) {
			const pending = this.pending.get(id);
			if (pending === undefined) return;
			this.pending.delete(id);
			if ("error" in parsed) {
				pending.reject(
					new CodexAppServerRequestError((parsed as { error: unknown }).error),
				);
			} else {
				pending.resolve((parsed as { result: unknown }).result);
			}
			return;
		}
		if (method !== null) {
			this.onNotification(parsed as ServerNotification);
		}
	}
}
