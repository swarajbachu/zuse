export type TerminalInputFailure = "write-failed" | "write-timeout";

export interface TerminalInputPump {
	readonly failed: boolean;
	enqueue(data: string): void;
	enqueueAndWait(data: string): Promise<boolean>;
	dispose(): void;
	whenIdle(): Promise<void>;
}

export const retainPendingInitialInput = (
	pending: string,
	incoming: string,
): string => (pending.length > 0 ? pending : incoming);

export function createTerminalInputPump(options: {
	readonly write: (data: string) => Promise<void>;
	readonly timeoutMs: number;
	readonly onFailure: (reason: TerminalInputFailure, cause?: unknown) => void;
	readonly onQueueHighWater?: (characters: number) => void;
}): TerminalInputPump {
	type InputBatch = {
		data: string;
		readonly resolve?: (written: boolean) => void;
	};
	const queued: InputBatch[] = [];
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

	const fail = (reason: TerminalInputFailure, cause?: unknown): void => {
		if (disposed || failed) return;
		failed = true;
		for (const batch of queued.splice(0)) batch.resolve?.(false);
		options.onFailure(reason, cause);
	};

	const writeWithTimeout = (data: string): Promise<void> =>
		new Promise((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(new Error("terminal input acknowledgement timed out"));
			}, options.timeoutMs);
			void options.write(data).then(
				() => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve();
				},
				(cause) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					reject(cause);
				},
			);
		});

	const drain = async (): Promise<void> => {
		if (writing || disposed || failed || queued.length === 0) return;
		writing = true;
		const batch = queued.shift();
		if (batch === undefined) {
			writing = false;
			resolveIdle();
			return;
		}
		try {
			await writeWithTimeout(batch.data);
			batch.resolve?.(true);
		} catch (cause) {
			batch.resolve?.(false);
			fail(
				cause instanceof Error &&
					cause.message === "terminal input acknowledgement timed out"
					? "write-timeout"
					: "write-failed",
				cause,
			);
		} finally {
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
			const tail = queued.at(-1);
			if (tail !== undefined && tail.resolve === undefined) tail.data += data;
			else queued.push({ data });
			const characters = queued.reduce(
				(total, batch) => total + batch.data.length,
				0,
			);
			if (characters > highWater) {
				highWater = characters;
				options.onQueueHighWater?.(highWater);
			}
			void drain();
		},
		enqueueAndWait(data) {
			if (disposed || failed || data.length === 0)
				return Promise.resolve(false);
			const completion = new Promise<boolean>((resolve) => {
				queued.push({ data, resolve });
			});
			const characters = queued.reduce(
				(total, batch) => total + batch.data.length,
				0,
			);
			if (characters > highWater) {
				highWater = characters;
				options.onQueueHighWater?.(highWater);
			}
			void drain();
			return completion;
		},
		dispose() {
			disposed = true;
			for (const batch of queued.splice(0)) batch.resolve?.(false);
			resolveIdle();
		},
		whenIdle() {
			if (!writing && queued.length === 0) return Promise.resolve();
			return new Promise<void>((resolve) => idleWaiters.push(resolve));
		},
	};
}
