import type {
	CompatibleJsonRpcMessage,
	JsonRpcError,
	JsonRpcId,
} from "./protocol.js";

export type AcpRpcId = JsonRpcId;
export type AcpRpcError = JsonRpcError;
export type AcpRpcMessage = CompatibleJsonRpcMessage;

export interface AcpRequestContext {
	readonly id: number;
	readonly method: string;
}

export interface AcpRequestOptions {
	readonly timeoutMs?: number;
	readonly onAssignedId?: (id: number) => void;
	readonly timeoutError?: (
		context: AcpRequestContext & { readonly timeoutMs: number },
	) => Error;
}

export interface AcpResponseOptions {
	readonly mapError?: (error: AcpRpcError, context: AcpRequestContext) => Error;
}

type PendingRequest = AcpRequestContext & {
	readonly resolve: (value: unknown) => void;
	readonly reject: (cause: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
};

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

export class AcpRpcClient {
	private readonly pending = new Map<number, PendingRequest>();
	private nextId = 1;

	constructor(private readonly write: (message: AcpRpcMessage) => void) {}

	get pendingCount(): number {
		return this.pending.size;
	}

	request(
		method: string,
		params: unknown,
		options: AcpRequestOptions = {},
	): Promise<unknown> {
		const id = this.nextId++;
		const timeoutMs = options.timeoutMs ?? 30_000;
		options.onAssignedId?.(id);
		const response = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					options.timeoutError?.({ id, method, timeoutMs }) ??
						new Error(`${method} timed out after ${timeoutMs}ms`),
				);
			}, timeoutMs);
			this.pending.set(id, { id, method, resolve, reject, timer });
		});
		try {
			this.write({ jsonrpc: "2.0", id, method, params });
		} catch (cause) {
			this.cancel(
				id,
				cause instanceof Error ? cause : new Error(String(cause)),
			);
		}
		return response;
	}

	notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	send(message: AcpRpcMessage): void {
		this.write(message);
	}

	acceptResponse(
		message: AcpRpcMessage,
		options: AcpResponseOptions = {},
	): boolean {
		if (typeof message.id !== "number" || message.method !== undefined) {
			return false;
		}
		const pending = this.pending.get(message.id);
		if (pending === undefined) return false;
		this.pending.delete(message.id);
		clearTimeout(pending.timer);
		if (message.error !== undefined) {
			pending.reject(
				options.mapError?.(message.error, pending) ??
					new AcpResponseError(
						message.error.code ?? -32603,
						`${pending.method} failed: ${message.error.message ?? "Unknown ACP error"}`,
						message.error.data,
					),
			);
		} else {
			pending.resolve("result" in message ? message.result : {});
		}
		return true;
	}

	cancel(id: number, cause: Error): AcpRequestContext | null {
		const pending = this.pending.get(id);
		if (pending === undefined) return null;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		pending.reject(cause);
		return { id, method: pending.method };
	}

	rejectAll(cause: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(cause);
		}
		this.pending.clear();
	}
}
