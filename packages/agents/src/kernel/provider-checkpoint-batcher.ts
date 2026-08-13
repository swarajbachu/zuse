import type { AgentEvent } from "@zuse/contracts";

const PROVIDER_CHECKPOINT_INTERVAL_MS = 50;
const PROVIDER_CHECKPOINT_MAX_BYTES = 4 * 1024;

interface CheckpointFlushSchedulerOptions {
	readonly onFlush: () => void;
	readonly intervalMs?: number;
	readonly maxBytes?: number;
}

/**
 * Shared deadline/size trigger for cumulative provider text. Callers own the
 * text buffer; this class owns the one timer and guarantees that non-empty
 * pending data is requested no later than the configured deadline or size.
 */
export class CheckpointFlushScheduler {
	readonly #onFlush: () => void;
	readonly #intervalMs: number;
	readonly #maxBytes: number;
	#pendingBytes = 0;
	#timer: ReturnType<typeof setTimeout> | null = null;

	constructor(options: CheckpointFlushSchedulerOptions) {
		this.#onFlush = options.onFlush;
		this.#intervalMs = options.intervalMs ?? PROVIDER_CHECKPOINT_INTERVAL_MS;
		this.#maxBytes = options.maxBytes ?? PROVIDER_CHECKPOINT_MAX_BYTES;
	}

	/** Replace the amount currently waiting to be checkpointed. */
	update(pendingBytes: number): void {
		this.#pendingBytes = Math.max(0, pendingBytes);
		if (this.#pendingBytes === 0) {
			this.cancel();
			return;
		}
		if (this.#pendingBytes >= this.#maxBytes) {
			this.flush();
			return;
		}
		if (this.#timer !== null) return;
		this.#timer = setTimeout(() => this.flush(), this.#intervalMs);
	}

	/** Request a flush now when data is pending. */
	flush(): void {
		if (this.#pendingBytes === 0) {
			this.cancel();
			return;
		}
		this.#clearTimer();
		this.#pendingBytes = 0;
		this.#onFlush();
	}

	/** Forget pending scheduling state without invoking the callback. */
	cancel(): void {
		this.#clearTimer();
		this.#pendingBytes = 0;
	}

	#clearTimer(): void {
		if (this.#timer === null) return;
		clearTimeout(this.#timer);
		this.#timer = null;
	}
}

type TextCheckpointEvent = Extract<
	AgentEvent,
	{ readonly _tag: "AssistantMessage" | "Thinking" }
> & {
	readonly checkpoint: { readonly revision: number; readonly final: boolean };
};

const checkpointKey = (event: TextCheckpointEvent): string =>
	`${event._tag}:${event.parentItemId ?? ""}:${event.itemId}`;

const isTextCheckpoint = (event: AgentEvent): event is TextCheckpointEvent =>
	(event._tag === "AssistantMessage" || event._tag === "Thinking") &&
	event.checkpoint !== undefined;

interface ProviderCheckpointBatcherOptions {
	readonly emit: (event: AgentEvent) => void;
	readonly intervalMs?: number;
	readonly maxBytes?: number;
}

/**
 * Coalesces absolute, non-final provider checkpoints at the driver boundary.
 * Final checkpoints and ordering boundaries are immediate. Because each
 * buffered value is cumulative, replacing an older value cannot lose text.
 */
export class ProviderCheckpointBatcher {
	readonly #emit: (event: AgentEvent) => void;
	readonly #pending = new Map<string, TextCheckpointEvent>();
	readonly #emittedBytes = new Map<string, number>();
	readonly #scheduler: CheckpointFlushScheduler;

	constructor(options: ProviderCheckpointBatcherOptions) {
		this.#emit = options.emit;
		this.#scheduler = new CheckpointFlushScheduler({
			onFlush: () => this.#flushPending(),
			intervalMs: options.intervalMs,
			maxBytes: options.maxBytes,
		});
	}

	offer(event: AgentEvent): void {
		if (isTextCheckpoint(event) && event.checkpoint.final === false) {
			const key = checkpointKey(event);
			const pending = this.#pending.get(key);
			if (
				pending !== undefined &&
				pending.checkpoint.revision >= event.checkpoint.revision
			)
				return;
			this.#pending.set(key, event);
			this.#reschedule();
			return;
		}

		if (isTextCheckpoint(event)) {
			// Preserve a partial checkpoint before final promotion. This is the last
			// recovery point if the process fails between the two durable commands.
			const key = checkpointKey(event);
			this.#flushPending();
			this.#emittedBytes.delete(key);
			this.#emit(event);
			return;
		}

		// Tool/lifecycle events are ordering boundaries: do not allow a timer to
		// publish earlier text after a later event.
		this.#flushPending();
		this.#emit(event);
	}

	flush(): void {
		this.#flushPending();
	}

	cancel(): void {
		this.#scheduler.cancel();
		this.#pending.clear();
		this.#emittedBytes.clear();
	}

	#reschedule(): void {
		let bytes = 0;
		for (const [key, event] of this.#pending) {
			const current = Buffer.byteLength(event.text);
			const emitted = this.#emittedBytes.get(key) ?? 0;
			bytes += current > emitted ? current - emitted : current;
		}
		this.#scheduler.update(bytes);
	}

	#flushPending(): void {
		this.#scheduler.cancel();
		if (this.#pending.size === 0) return;
		const pending = [...this.#pending.entries()];
		this.#pending.clear();
		for (const [key, event] of pending) {
			this.#emittedBytes.set(key, Buffer.byteLength(event.text));
			this.#emit(event);
		}
	}
}
