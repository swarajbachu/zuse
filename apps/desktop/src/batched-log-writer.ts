import { Buffer } from "node:buffer";

export type BatchedLogWriter = {
	readonly append: (filePath: string, line: string) => void;
	readonly flush: (filePath?: string) => Promise<void>;
};

type FileQueue = {
	readonly pending: Array<{ readonly line: string; readonly bytes: number }>;
	pendingBytes: number;
	draining: Promise<void> | undefined;
	droppedLines: number;
	droppedBytes: number;
};

const droppedLine = (lines: number, bytes: number): string =>
	JSON.stringify({
		ts: new Date().toISOString(),
		event: "log.lines.dropped",
		lines,
		bytes,
	});

export const makeBatchedLogWriter = (options: {
	readonly writeBatch: (
		filePath: string,
		lines: ReadonlyArray<string>,
	) => Promise<void>;
	readonly maxPendingLines?: number;
	readonly maxPendingBytes?: number;
	readonly maxLineBytes?: number;
	readonly batchSize?: number;
}): BatchedLogWriter => {
	const maxPendingLines = Math.max(options.maxPendingLines ?? 1_000, 1);
	const maxPendingBytes = Math.max(
		options.maxPendingBytes ?? 4 * 1024 * 1024,
		1,
	);
	const maxLineBytes = Math.min(
		Math.max(options.maxLineBytes ?? 256 * 1024, 1),
		maxPendingBytes,
	);
	const batchSize = Math.max(options.batchSize ?? 100, 1);
	const queues = new Map<string, FileQueue>();

	const startDrain = (filePath: string, queue: FileQueue): void => {
		if (queue.draining !== undefined) return;
		queue.draining = (async () => {
			while (queue.pending.length > 0 || queue.droppedLines > 0) {
				const entries = queue.pending.splice(0, batchSize);
				queue.pendingBytes -= entries.reduce(
					(total, entry) => total + entry.bytes,
					0,
				);
				const lines = entries.map((entry) => entry.line);
				if (queue.droppedLines > 0) {
					lines.unshift(droppedLine(queue.droppedLines, queue.droppedBytes));
					queue.droppedLines = 0;
					queue.droppedBytes = 0;
				}
				await options.writeBatch(filePath, lines).catch(() => undefined);
			}
		})().finally(() => {
			queue.draining = undefined;
			if (queue.pending.length > 0 || queue.droppedLines > 0) {
				startDrain(filePath, queue);
			} else if (queue.droppedLines === 0) {
				queues.delete(filePath);
			}
		});
	};

	const append = (filePath: string, line: string): void => {
		const queue = queues.get(filePath) ?? {
			pending: [],
			pendingBytes: 0,
			draining: undefined,
			droppedLines: 0,
			droppedBytes: 0,
		};
		queues.set(filePath, queue);
		const bytes = Buffer.byteLength(line, "utf8");
		if (bytes > maxLineBytes) {
			queue.droppedLines += 1;
			queue.droppedBytes += bytes;
			startDrain(filePath, queue);
			return;
		}
		while (
			queue.pending.length > 0 &&
			(queue.pending.length >= maxPendingLines ||
				queue.pendingBytes + bytes > maxPendingBytes)
		) {
			const dropped = queue.pending.shift();
			if (dropped === undefined) break;
			queue.pendingBytes -= dropped.bytes;
			queue.droppedLines += 1;
			queue.droppedBytes += dropped.bytes;
		}
		queue.pending.push({ line, bytes });
		queue.pendingBytes += bytes;
		startDrain(filePath, queue);
	};

	const flush = async (filePath?: string): Promise<void> => {
		const targets =
			filePath === undefined
				? [...queues.entries()]
				: ([[filePath, queues.get(filePath)]] as const);
		await Promise.all(
			targets.map(async ([path, queue]) => {
				if (queue === undefined) return;
				startDrain(path, queue);
				while (queue.draining !== undefined) {
					await queue.draining;
				}
			}),
		);
	};

	return { append, flush };
};
