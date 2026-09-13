import { spawn } from "node:child_process";

export type PiFrame = Record<string, unknown>;
export const piObject = (value: unknown): PiFrame =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as PiFrame)
		: {};

/** Pi uses LF-delimited JSON, not JSON-RPC or terminal line semantics. */
export class PiRpcClient {
	readonly child;
	#buffer = "";
	#sequence = 0;
	#closed = false;
	#closing = false;
	#diagnostic = "";
	#pending = new Map<
		string,
		{
			resolve: (value: PiFrame) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout> | undefined;
		}
	>();
	#exited: Promise<void>;
	constructor(
		binary: string,
		args: string[],
		cwd: string,
		onEvent: (event: PiFrame) => void,
		onExit: (error: Error) => void = () => {},
	) {
		this.child = spawn(binary, args, {
			cwd,
			env: process.env,
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.#exited = new Promise((resolve) =>
			this.child.once("close", () => resolve()),
		);
		const fail = (error: Error) => {
			if (this.#closed) return;
			this.#closed = true;
			for (const pending of this.#pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(error);
			}
			this.#pending.clear();
			if (!this.#closing) {
				onExit(error);
				void this.close();
			}
		};
		this.child.on("error", (error) => fail(error));
		this.child.stdin.on("error", (error) => fail(error));
		// Classify bounded diagnostics without exposing credential or prompt payloads.
		let stderrTail = "";
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => {
			stderrTail = (stderrTail + chunk).slice(-4096);
			if (this.#diagnostic) return;
			if (/unknown (?:argument|option)|invalid.*mode/i.test(stderrTail))
				this.#diagnostic = "Upgrade Pi to a version supporting RPC mode.";
			else if (/api.?key|auth|login|credential/i.test(stderrTail))
				this.#diagnostic =
					"Check Pi authentication with pi /login or its provider credentials.";
			else if (/extension/i.test(stderrTail))
				this.#diagnostic = "Check the configured Pi extensions.";
		});
		this.child.on("close", (code, signal) =>
			fail(
				new Error(
					`Pi process exited (${signal ?? code})${this.#buffer.length ? " with an incomplete RPC frame" : ""}. ${this.#diagnostic}`,
				),
			),
		);
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => {
			this.#buffer += chunk;
			while (true) {
				const end = this.#buffer.indexOf("\n");
				if (end < 0) break;
				const line = this.#buffer.slice(0, end).replace(/\r$/, "");
				this.#buffer = this.#buffer.slice(end + 1);
				if (!line.trim()) continue;
				if (line.length > 32 * 1024 * 1024) {
					fail(new Error("Pi RPC frame exceeded 32 MiB."));
					return;
				}
				try {
					const frame = piObject(JSON.parse(line));
					if (typeof frame.type !== "string")
						throw new Error("Missing frame type");
					if (frame.type === "response") {
						const pending = this.#pending.get(String(frame.id));
						if (!pending) continue;
						this.#pending.delete(String(frame.id));
						clearTimeout(pending.timer);
						if (frame.success === true) pending.resolve(piObject(frame.data));
						else
							pending.reject(
								new Error(
									typeof frame.error === "string"
										? frame.error
										: `Pi rejected ${String(frame.command)}`,
								),
							);
					} else onEvent(frame);
				} catch {
					fail(
						new Error(
							"Pi emitted malformed RPC output. Check the CLI version and extensions.",
						),
					);
					this.#kill("SIGTERM");
					return;
				}
			}
			if (this.#buffer.length > 32 * 1024 * 1024) {
				fail(new Error("Pi RPC frame exceeded 32 MiB."));
				this.#kill("SIGTERM");
			}
		});
	}
	notify(frame: PiFrame): void {
		if (this.#closed || !this.child.stdin.writable)
			throw new Error("Pi process is closed.");
		this.child.stdin.write(`${JSON.stringify(frame)}\n`);
	}
	request(
		type: string,
		fields: PiFrame = {},
		timeoutMs: number | null = 30_000,
	): Promise<PiFrame> {
		if (this.#closed) return Promise.reject(new Error("Pi process is closed."));
		const id = String(++this.#sequence);
		return new Promise((resolve, reject) => {
			const timer =
				timeoutMs === null
					? undefined
					: setTimeout(() => {
							this.#pending.delete(id);
							reject(
								new Error(
									`Pi ${type} timed out after ${timeoutMs}ms. ${this.#diagnostic}`,
								),
							);
						}, timeoutMs);
			this.#pending.set(id, { resolve, reject, timer });
			try {
				this.notify({ ...fields, type, id });
			} catch (error) {
				clearTimeout(timer);
				this.#pending.delete(id);
				reject(error);
			}
		});
	}
	#kill(signal: NodeJS.Signals): void {
		try {
			if (process.platform !== "win32" && this.child.pid)
				process.kill(-this.child.pid, signal);
			else this.child.kill(signal);
		} catch {
			/* The process may already have exited. */
		}
	}
	async close(): Promise<void> {
		if (this.#closing) return this.#exited;
		this.#closing = true;
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Pi session closed."));
		}
		this.#pending.clear();
		this.#closed = true;
		this.child.stdin.end();
		this.#kill("SIGTERM");
		const timer = setTimeout(() => this.#kill("SIGKILL"), 1500);
		await this.#exited;
		clearTimeout(timer);
	}
}
