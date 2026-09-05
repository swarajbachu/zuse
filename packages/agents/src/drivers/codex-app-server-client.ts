import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline from "node:readline";
import type { ClientRequest } from "@zuse/agents/codex-generated/ClientRequest";
import type { InitializeResponse } from "@zuse/agents/codex-generated/InitializeResponse";
import type { ServerNotification } from "@zuse/agents/codex-generated/ServerNotification";
import type { ServerRequest } from "@zuse/agents/codex-generated/ServerRequest";
import { reportCodexStderr } from "./codex-stderr-reporter.ts";

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

export type CodexAppMcpLaunchConfig =
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
	  };

export const codexAppServerLaunchArgs = (
	mcp?: CodexAppMcpLaunchConfig,
): ReadonlyArray<string> => [
	"app-server",
	"--listen",
	"stdio://",
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
		readonly env?: NodeJS.ProcessEnv;
		readonly mcp?: CodexAppMcpLaunchConfig;
		readonly startupTimeoutMs?: number;
		readonly onStderr?: (text: string) => void;
		readonly onNotification: NotificationHandler;
		readonly onServerRequest: ServerRequestHandler;
		readonly externalAuthProvider?: CodexExternalAuthProvider;
		/** Session identity used only to resume a proven auth-blocked consumer. */
		readonly externalAuthConsumerId?: string;
		readonly onUnexpectedTermination?: UnexpectedTerminationHandler;
	}): Promise<CodexAppServerClient> {
		const externalAuthProvider =
			options.externalAuthProvider ?? defaultExternalAuthProvider;
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
			[...codexAppServerLaunchArgs(options.mcp)],
			options.env === undefined ? undefined : { env: options.env },
		);
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
		child.stderr.on("data", (chunk) => {
			bootstrap.appendStderr(String(chunk));
			const text = String(chunk).trim();
			if (text.length === 0) return;
			if (options.onStderr !== undefined) options.onStderr(text);
			else reportCodexStderr(text);
		});
		// Without this listener, a spawn-time failure (ENOENT when codex isn't on
		// PATH, EACCES on a non-executable file) becomes an uncaught exception
		// that crashes the whole process. Surface it as a rejection of every
		// pending request — including the `initialize` we're about to await —
		// so callers see a normal Effect failure they already know how to catch.
		child.once("error", (err) => bootstrap.handleUnexpectedTermination(err));
		child.once("close", (code, signal) => {
			bootstrap.handleUnexpectedTermination(
				new Error(
					`Codex app-server exited with ${signal ?? `code ${code ?? 0}`}`,
				),
			);
		});

		let timer: NodeJS.Timeout | undefined;
		try {
			const initialize = bootstrap.request<InitializeResponse>("initialize", {
				clientInfo: { name: "zuse", version: "0.0.0" },
				capabilities: {
					experimentalApi: true,
				},
			});
			const init =
				options.startupTimeoutMs === undefined
					? await initialize
					: await Promise.race([
							initialize,
							new Promise<never>((_resolve, reject) => {
								timer = setTimeout(
									() => reject(new Error("Codex app-server startup timed out")),
									options.startupTimeoutMs,
								);
							}),
						]);
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
			return bootstrap;
		} catch (cause) {
			bootstrap.close();
			throw cause;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	request<T>(
		method:
			| ClientRequest["method"]
			| CodexGoalRequestMethod
			| CodexExperimentalRequestMethod,
		params: unknown,
	): Promise<T> {
		if (this.closed) {
			return Promise.reject(new Error("Codex app-server is closed"));
		}
		const id = this.nextId++;
		const message =
			params === undefined ? { id, method } : { id, method, params };
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, {
				resolve: (value) => resolve(value as T),
				reject,
			});
			this.child.stdin.write(`${JSON.stringify(message)}\n`, (err) => {
				if (err) {
					this.pending.delete(id);
					reject(err);
				}
			});
		});
	}

	respond(id: RequestId, result: unknown): void {
		if (this.closed) return;
		this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.rl.close();
		this.rejectPending(new Error("Codex app-server is closed"));
		this.child.kill();
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
		// `error` and `close` may both fire for one failed child. The first signal
		// owns termination; an explicit close sets `closed` before killing the child
		// and therefore remains intentionally quiet.
		if (this.closed) return;
		this.closed = true;
		this.rl.close();
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
