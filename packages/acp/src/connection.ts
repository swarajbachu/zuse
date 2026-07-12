import type { Readable, Writable } from "node:stream";
import { Schema } from "effect";

import { JsonRpcMessage, type JsonRpcNotification } from "./protocol.js";
import {
	AcpResponseError,
	AcpRpcClient,
	type AcpRpcMessage,
} from "./rpc-client.js";

export { AcpResponseError } from "./rpc-client.js";

export class AcpConnectionClosedError extends Error {
	constructor(message = "ACP connection closed") {
		super(message);
		this.name = "AcpConnectionClosedError";
	}
}

export class AcpConnection {
	private readonly listeners = new Set<
		(message: JsonRpcNotification) => void
	>();
	private readonly rpc: AcpRpcClient;
	private buffer = "";
	private closed = false;

	constructor(
		private readonly readable: Readable,
		private readonly writable: Writable,
	) {
		this.rpc = new AcpRpcClient((message) => {
			if (this.closed) throw new AcpConnectionClosedError();
			this.writable.write(`${JSON.stringify(message)}\n`);
		});
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
		if (this.closed) throw new AcpConnectionClosedError();
		this.rpc.notify(method, params);
	}

	async request<A>(
		method: string,
		params: unknown,
		result: Schema.Codec<A>,
	): Promise<A> {
		if (this.closed) throw new AcpConnectionClosedError();
		return Schema.decodeUnknownPromise(result)(
			await this.rpc.request(method, params),
		);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.detach();
		this.rpc.rejectAll(new AcpConnectionClosedError());
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
		if ("id" in message) {
			this.rpc.acceptResponse(message as AcpRpcMessage, {
				mapError: (error) =>
					new AcpResponseError(
						error.code ?? -32603,
						error.message ?? "Unknown ACP error",
						error.data,
					),
			});
			return;
		}
		if (!("id" in message)) {
			for (const listener of this.listeners) listener(message);
		}
	}

	private readonly onEnd = (): void => this.close();
	private readonly onError = (cause: Error): void => this.failAll(cause);

	private failAll(cause: unknown): void {
		this.rpc.rejectAll(
			cause instanceof Error ? cause : new Error(String(cause)),
		);
	}

	private detach(): void {
		this.readable.off("data", this.onData);
		this.readable.off("end", this.onEnd);
		this.readable.off("error", this.onError);
		this.writable.off("error", this.onError);
	}
}
