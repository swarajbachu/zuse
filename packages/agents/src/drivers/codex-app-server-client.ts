import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline from "node:readline";
import type { ClientRequest } from "@zuse/agents/codex-generated/ClientRequest";
import type { InitializeResponse } from "@zuse/agents/codex-generated/InitializeResponse";
import type { ServerNotification } from "@zuse/agents/codex-generated/ServerNotification";
import type { ServerRequest } from "@zuse/agents/codex-generated/ServerRequest";

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

type CodexGoalRequestMethod =
	| "thread/goal/get"
	| "thread/goal/set"
	| "thread/goal/clear";

type CodexExperimentalRequestMethod = "collaborationMode/list";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const errorMessage = (error: unknown): string => {
	if (isRecord(error) && typeof error.message === "string")
		return error.message;
	return JSON.stringify(error);
};

export class CodexAppServerClient {
	private nextId: RequestId = 1;
	private readonly pending = new Map<RequestId, Pending>();
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly rl: readline.Interface;
	private closed = false;

	initializeResponse: InitializeResponse;

	private constructor(
		child: ChildProcessWithoutNullStreams,
		rl: readline.Interface,
		initializeResponse: InitializeResponse,
		readonly onNotification: NotificationHandler,
		readonly onServerRequest: ServerRequestHandler,
	) {
		this.child = child;
		this.rl = rl;
		this.initializeResponse = initializeResponse;
	}

	static async start(options: {
		readonly codexPath: string | null;
		readonly env?: NodeJS.ProcessEnv;
		readonly startupTimeoutMs?: number;
		readonly onNotification: NotificationHandler;
		readonly onServerRequest: ServerRequestHandler;
	}): Promise<CodexAppServerClient> {
		const child = spawn(
			options.codexPath ?? "codex",
			["app-server", "--listen", "stdio://"],
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
			options.onServerRequest,
		);
		rl.on("line", (line) => bootstrap.handleLine(line));
		child.stderr.on("data", (chunk) => {
			const text = String(chunk).trim();
			if (text.length > 0) console.warn(`[codex-app-server] ${text}`);
		});
		// Without this listener, a spawn-time failure (ENOENT when codex isn't on
		// PATH, EACCES on a non-executable file) becomes an uncaught exception
		// that crashes the whole process. Surface it as a rejection of every
		// pending request — including the `initialize` we're about to await —
		// so callers see a normal Effect failure they already know how to catch.
		child.once("error", (err) => {
			bootstrap.closed = true;
			for (const p of bootstrap.pending.values()) p.reject(err as Error);
			bootstrap.pending.clear();
		});
		child.once("exit", (code, signal) => {
			bootstrap.closed = true;
			const reason = new Error(
				`Codex app-server exited with ${signal ?? `code ${code ?? 0}`}`,
			);
			for (const p of bootstrap.pending.values()) p.reject(reason);
			bootstrap.pending.clear();
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
		this.child.kill();
	}

	private handleLine(line: string): void {
		if (line.trim().length === 0) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			console.warn(`[codex-app-server] non-json stdout: ${line}`);
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
					new Error(errorMessage((parsed as { error: unknown }).error)),
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
