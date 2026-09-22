export interface TerminalInputPump {
	readonly failed: boolean;
	enqueue(data: string): void;
	enqueueAndWait(data: string): Promise<boolean>;
	dispose(): void;
	whenIdle(): Promise<void>;
}

/** Shared bound for terminal input retained before or during a PTY write. */
export const TERMINAL_INPUT_QUEUE_CHARACTER_LIMIT = 1024 * 1024;

export type PendingTerminalInput = Readonly<{
	data: string;
	overflowed: boolean;
}>;

/**
 * Append input captured before a terminal surface can mount. Returning a new
 * value makes this safe for React functional state updates, including several
 * key/paste events batched into one render. An overflowing chunk is rejected
 * whole so a paste or escape sequence is never sent partially.
 */
export const appendPendingTerminalInput = (
	current: PendingTerminalInput,
	incoming: string,
	limit = TERMINAL_INPUT_QUEUE_CHARACTER_LIMIT,
): PendingTerminalInput => {
	if (incoming.length === 0) return current;
	if (current.data.length + incoming.length > limit) {
		return current.overflowed ? current : { ...current, overflowed: true };
	}
	return { data: current.data + incoming, overflowed: false };
};

export const retainPendingInitialInput = (
	pending: string,
	incoming: string,
): string => (pending.length > 0 ? pending : incoming);

export function createTerminalInputPump(options: {
	readonly write: (data: string) => Promise<void>;
	/** Emit one non-fatal diagnostic when an acknowledgement takes this long. */
	readonly stallWarningMs?: number;
	readonly maxQueuedCharacters?: number;
	readonly maxQueuedBatches?: number;
	readonly onFailure: (cause?: unknown) => void;
	readonly onStall?: (elapsedMs: number) => void;
	readonly onQueueHighWater?: (characters: number) => void;
}): TerminalInputPump {
	type InputBatch = {
		readonly chunks: string[];
		characters: number;
		readonly resolve?: (written: boolean) => void;
	};
	const queueCharacterLimit =
		options.maxQueuedCharacters !== undefined &&
		Number.isFinite(options.maxQueuedCharacters)
			? Math.max(1, Math.floor(options.maxQueuedCharacters))
			: TERMINAL_INPUT_QUEUE_CHARACTER_LIMIT;
	const queueBatchLimit =
		options.maxQueuedBatches !== undefined &&
		Number.isFinite(options.maxQueuedBatches)
			? Math.max(1, Math.floor(options.maxQueuedBatches))
			: 1_024;
	const stallWarningMs =
		options.stallWarningMs !== undefined &&
		Number.isFinite(options.stallWarningMs) &&
		options.stallWarningMs > 0
			? Math.max(1, Math.floor(options.stallWarningMs))
			: null;
	const queued: InputBatch[] = [];
	let queuedCharacters = 0;
	let inFlightCharacters = 0;
	let writing = false;
	let disposed = false;
	let failed = false;
	let highWater = 0;
	let idleWaiters: Array<() => void> = [];

	const resolveIdle = (): void => {
		if (writing || queued.length > 0) return;
		const waiters = idleWaiters;
		idleWaiters = [];
		for (const resolve of waiters) resolve();
	};

	const fail = (cause?: unknown): void => {
		if (disposed || failed) return;
		failed = true;
		for (const batch of queued.splice(0)) batch.resolve?.(false);
		queuedCharacters = 0;
		options.onFailure(cause);
	};

	const retain = (
		data: string,
		resolve?: (written: boolean) => void,
	): boolean => {
		const tail = queued.at(-1);
		const canCoalesce =
			resolve === undefined && tail !== undefined && tail.resolve === undefined;
		const retainedCharacters =
			inFlightCharacters + queuedCharacters + data.length;
		const retainedBatches =
			(writing ? 1 : 0) + queued.length + (canCoalesce ? 0 : 1);
		if (
			retainedCharacters > queueCharacterLimit ||
			retainedBatches > queueBatchLimit
		) {
			resolve?.(false);
			fail(new Error("terminal input queue capacity exceeded"));
			return false;
		}
		if (canCoalesce && tail !== undefined) {
			tail.chunks.push(data);
			tail.characters += data.length;
		} else {
			queued.push({ chunks: [data], characters: data.length, resolve });
		}
		queuedCharacters += data.length;
		if (retainedCharacters > highWater) {
			highWater = retainedCharacters;
			options.onQueueHighWater?.(highWater);
		}
		return true;
	};

	const writeWithStallWarning = async (data: string): Promise<void> => {
		const timer =
			stallWarningMs === null || options.onStall === undefined
				? null
				: setTimeout(() => {
						if (disposed || failed) return;
						try {
							options.onStall?.(stallWarningMs);
						} catch {
							// Diagnostics must never alter input delivery semantics.
						}
					}, stallWarningMs);
		try {
			await options.write(data);
		} finally {
			if (timer !== null) clearTimeout(timer);
		}
	};

	const drain = async (): Promise<void> => {
		if (writing || disposed || failed || queued.length === 0) return;
		writing = true;
		const batch = queued.shift();
		if (batch === undefined) {
			writing = false;
			resolveIdle();
			return;
		}
		queuedCharacters -= batch.characters;
		inFlightCharacters = batch.characters;
		try {
			await writeWithStallWarning(batch.chunks.join(""));
			batch.resolve?.(true);
		} catch (cause) {
			batch.resolve?.(false);
			fail(cause);
		} finally {
			inFlightCharacters = 0;
			writing = false;
			if (!disposed && !failed && queued.length > 0) void drain();
			else resolveIdle();
		}
	};

	return {
		get failed() {
			return failed;
		},
		enqueue(data) {
			if (disposed || failed || data.length === 0) return;
			if (!retain(data)) return;
			void drain();
		},
		enqueueAndWait(data) {
			if (disposed || failed || data.length === 0)
				return Promise.resolve(false);
			const completion = new Promise<boolean>((resolve) => {
				if (!retain(data, resolve)) return;
			});
			void drain();
			return completion;
		},
		dispose() {
			disposed = true;
			for (const batch of queued.splice(0)) batch.resolve?.(false);
			queuedCharacters = 0;
			resolveIdle();
		},
		whenIdle() {
			if (!writing && queued.length === 0) return Promise.resolve();
			return new Promise<void>((resolve) => idleWaiters.push(resolve));
		},
	};
}
