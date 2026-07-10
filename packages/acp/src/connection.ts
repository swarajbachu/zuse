import type { Readable, Writable } from "node:stream";
import { Schema } from "effect";

import { JsonRpcMessage, type JsonRpcNotification } from "./protocol.js";

export class AcpConnectionClosedError extends Error {
	constructor(message = "ACP connection closed") {
		super(message);
		this.name = "AcpConnectionClosedError";
	}
}

export class AcpResponseError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
		this.name = "AcpResponseError";
	}
}

type Pending = {
	readonly resolve: (value: unknown) => void;
	readonly reject: (cause: unknown) => void;
};

export class AcpConnection {
	private readonly pending = new Map<string | number, Pending>();
	private readonly listeners = new Set<
		(message: JsonRpcNotification) => void
	>();
	private buffer = "";
	private nextId = 1;
	private closed = false;

	constructor(
		private readonly readable: Readable,
		private readonly writable: Writable,
	) {
		readable.setEncoding("utf8");
		readable.on("data", this.onData);
		readable.once("end", this.onEnd);
		readable.once("error", this.onError);
		writable.once("error", this.onError);
	}

	subscribe(listener: (message: JsonRpcNotification) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	notify(method: string, params?: unknown): void {
		this.write({
			jsonrpc: "2.0",
			method,
			...(params === undefined ? {} : { params }),
		});
	}

	async request<A>(
		method: string,
		params: unknown,
		result: Schema.Codec<A>,
	): Promise<A> {
		if (this.closed) throw new AcpConnectionClosedError();
		const id = this.nextId++;
		const response = new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
		});
		this.write({ jsonrpc: "2.0", id, method, params });
		return Schema.decodeUnknownPromise(result)(await response);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.detach();
		const error = new AcpConnectionClosedError();
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	private readonly onData = (chunk: string): void => {
		this.buffer += chunk;
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line.length === 0) continue;
			this.receive(line);
		}
	};

	private receive(line: string): void {
		let message: JsonRpcMessage;
		try {
			message = Schema.decodeUnknownSync(JsonRpcMessage)(JSON.parse(line));
		} catch (cause) {
			this.failAll(cause);
			return;
		}
		if ("id" in message && "result" in message) {
			this.pending.get(message.id)?.resolve(message.result);
			this.pending.delete(message.id);
			return;
		}
		if ("id" in message && "error" in message) {
			if (message.id !== null) {
				this.pending
					.get(message.id)
					?.reject(
						new AcpResponseError(
							message.error.code,
							message.error.message,
							message.error.data,
						),
					);
				this.pending.delete(message.id);
			}
			return;
		}
		if (!("id" in message)) {
			for (const listener of this.listeners) listener(message);
		}
	}

	private write(message: unknown): void {
		if (this.closed) throw new AcpConnectionClosedError();
		this.writable.write(`${JSON.stringify(message)}\n`);
	}

	private readonly onEnd = (): void => this.close();
	private readonly onError = (cause: Error): void => this.failAll(cause);

	private failAll(cause: unknown): void {
		for (const pending of this.pending.values()) pending.reject(cause);
		this.pending.clear();
	}

	private detach(): void {
		this.readable.off("data", this.onData);
		this.readable.off("end", this.onEnd);
		this.readable.off("error", this.onError);
		this.writable.off("error", this.onError);
	}
}
