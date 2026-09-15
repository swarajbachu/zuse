import type { Readable, Writable } from "node:stream";
import { Schema } from "effect";

import {
	JsonRpcMessage,
	type JsonRpcNotification,
	type JsonRpcRequest,
} from "./protocol.js";
import {
	type AcpRequestOptions,
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
	private incoming = new Set<string | number>();

	constructor(
		private readonly readable: Readable,
		private readonly writable: Writable,
		private readonly options: {
			readonly maxMessageBytes?: number;
			readonly onRequest?: (
				request: JsonRpcRequest,
				respond: (result: unknown) => void,
				reject: (code: number, message: string) => void,
			) => void;
			readonly onClose?: (cause: Error) => void;
		} = {},
	) {
		this.rpc = new AcpRpcClient((message) => {
			if (this.closed) throw new AcpConnectionClosedError();
			const line = `${JSON.stringify(message)}\n`;
			if (
				Buffer.byteLength(line) >
				(this.options.maxMessageBytes ?? 2 * 1024 * 1024)
			)
				throw new Error("ACP message exceeds the size limit.");
			if (
				this.writable.writableLength + Buffer.byteLength(line) >
				4 * 1024 * 1024
			)
				throw new Error("ACP write queue overflowed.");
			this.writable.write(line, (error) => {
				if (error) this.failAll(error);
			});
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
		options: AcpRequestOptions = {},
	): Promise<A> {
		if (this.closed) throw new AcpConnectionClosedError();
		if (this.rpc.pendingCount >= 128)
			throw new Error("Too many pending ACP requests.");
		return Schema.decodeUnknownPromise(result)(
			await this.rpc.request(method, params, options),
		);
	}

	close(cause: Error = new AcpConnectionClosedError()): void {
		if (this.closed) return;
		this.closed = true;
		this.detach();
		this.rpc.rejectAll(cause);
		this.incoming.clear();
		this.listeners.clear();
		this.buffer = "";
		this.options.onClose?.(cause);
	}

	private readonly onData = (chunk: string): void => {
		this.buffer += chunk;
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) {
				if (
					Buffer.byteLength(this.buffer) >
					(this.options.maxMessageBytes ?? 2 * 1024 * 1024)
				)
					this.failAll(new Error("ACP message exceeds the size limit."));
				return;
			}
			if (
				Buffer.byteLength(this.buffer.slice(0, newline)) >
				(this.options.maxMessageBytes ?? 2 * 1024 * 1024)
			) {
				this.failAll(new Error("ACP message exceeds the size limit."));
				return;
			}
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line.length === 0) continue;
			this.receive(line);
			if (this.closed) return;
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
		if ("id" in message && "method" in message) {
			if (this.incoming.has(message.id) || this.incoming.size >= 32) {
				this.failAll(new Error("ACP incoming request limit exceeded."));
				return;
			}
			const id = message.id;
			this.incoming.add(id);
			const reply = (
				value:
					| { result: unknown }
					| { error: { code: number; message: string } },
			) => {
				if (this.closed || !this.incoming.delete(id)) return;
				try {
					this.rpc.send({ jsonrpc: "2.0", id, ...value });
				} catch (error) {
					this.failAll(error);
				}
			};
			const reject = (code: number, message: string) =>
				reply({ error: { code, message } });
			try {
				if (this.options.onRequest)
					this.options.onRequest(
						message,
						(result) => reply({ result }),
						reject,
					);
				else reject(-32601, "Client method not supported.");
			} catch {
				reject(-32603, "Client request failed.");
			}
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
			try {
				for (const listener of this.listeners) listener(message);
			} catch (cause) {
				this.failAll(cause);
			}
		}
	}

	private readonly onEnd = (): void => this.close();
	private readonly onError = (cause: Error): void => this.failAll(cause);

	private failAll(cause: unknown): void {
		this.close(cause instanceof Error ? cause : new Error(String(cause)));
	}

	private detach(): void {
		this.readable.off("data", this.onData);
		this.readable.off("end", this.onEnd);
		this.readable.off("error", this.onError);
		this.writable.off("error", this.onError);
	}
}
