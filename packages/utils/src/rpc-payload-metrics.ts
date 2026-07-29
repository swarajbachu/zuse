import { RpcSerialization } from "effect/unstable/rpc";

export type RpcPayloadDirection = "inbound" | "outbound";

export type RpcPayloadSample = {
	readonly direction: RpcPayloadDirection;
	readonly rpc: string;
	readonly bytes: number;
	readonly durationMs: number;
	readonly frames: number;
};

export type RpcPayloadMetric = {
	readonly direction: RpcPayloadDirection;
	readonly rpc: string;
	readonly frames: number;
	readonly uncompressedBytes: number;
	readonly maxUncompressedFrameBytes: number;
	readonly serializationAndMeasurementMs: number;
};

export type RpcPayloadReport = {
	readonly transport: string;
	readonly frames: number;
	readonly uncompressedBytes: number;
	readonly maxUncompressedFrameBytes: number;
	readonly serializationAndMeasurementMs: number;
	readonly metrics: ReadonlyArray<RpcPayloadMetric>;
};

type EncodedRpcMessage = {
	readonly _tag?: string;
	readonly id?: string | number;
	readonly requestId?: string | number;
	readonly tag?: string;
};

const stringUtf8ByteLength = (value: string): number => {
	let bytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 0x80) {
			bytes += 1;
		} else if (code < 0x800) {
			bytes += 2;
		} else if (
			code >= 0xd800 &&
			code <= 0xdbff &&
			index + 1 < value.length &&
			value.charCodeAt(index + 1) >= 0xdc00 &&
			value.charCodeAt(index + 1) <= 0xdfff
		) {
			bytes += 4;
			index += 1;
		} else {
			bytes += 3;
		}
	}
	return bytes;
};

const byteLength = (value: string | Uint8Array): number =>
	typeof value === "string" ? stringUtf8ByteLength(value) : value.byteLength;

const encodedMessages = (value: unknown): ReadonlyArray<EncodedRpcMessage> =>
	Array.isArray(value)
		? value.filter(
				(item): item is EncodedRpcMessage =>
					typeof item === "object" && item !== null,
			)
		: typeof value === "object" && value !== null
			? [value as EncodedRpcMessage]
			: [];

const rpcLabel = (
	messages: ReadonlyArray<EncodedRpcMessage>,
	requestTags: Map<string | number, string>,
): string => {
	const labels = new Set<string>();
	for (const message of messages) {
		if (
			message._tag === "Request" &&
			message.id !== undefined &&
			typeof message.tag === "string"
		) {
			requestTags.set(message.id, message.tag);
			labels.add(message.tag);
			continue;
		}
		const requestId = message.requestId;
		if (requestId !== undefined) {
			labels.add(
				requestTags.get(requestId) ?? `@${message._tag ?? "response"}`,
			);
			if (message._tag === "Exit" || message._tag === "Interrupt") {
				requestTags.delete(requestId);
			}
			continue;
		}
		labels.add(`@${message._tag ?? "unknown"}`);
	}
	return labels.size === 1
		? (labels.values().next().value ?? "@unknown")
		: "@batch";
};

export const makeMeasuredJsonRpcSerialization = (options: {
	readonly encodeDirection: RpcPayloadDirection;
	readonly decodeDirection: RpcPayloadDirection;
	readonly record: (sample: RpcPayloadSample) => void;
}): RpcSerialization.RpcSerialization["Service"] =>
	RpcSerialization.RpcSerialization.of({
		contentType: RpcSerialization.json.contentType,
		includesFraming: RpcSerialization.json.includesFraming,
		makeUnsafe: () => {
			const parser = RpcSerialization.json.makeUnsafe();
			const requestTags = new Map<string | number, string>();
			return {
				decode: (input) => {
					const startedAt = performance.now();
					const decoded = parser.decode(input);
					options.record({
						direction: options.decodeDirection,
						rpc: rpcLabel(encodedMessages(decoded), requestTags),
						bytes: byteLength(input),
						durationMs: performance.now() - startedAt,
						frames: decoded.length,
					});
					return decoded;
				},
				encode: (message) => {
					const startedAt = performance.now();
					const encoded = parser.encode(message);
					if (encoded !== undefined) {
						const bytes = byteLength(encoded);
						options.record({
							direction: options.encodeDirection,
							rpc: rpcLabel(encodedMessages(message), requestTags),
							bytes,
							durationMs: performance.now() - startedAt,
							frames: Array.isArray(message) ? message.length : 1,
						});
					}
					return encoded;
				},
			};
		},
	});

export const makeRpcPayloadReporter = (options: {
	readonly transport: string;
	readonly onReport: (report: RpcPayloadReport) => void;
	readonly flushEveryFrames?: number;
	readonly flushOnFrameBytes?: number;
	readonly flushAfterMs?: number;
}) => {
	const flushEveryFrames = options.flushEveryFrames ?? 100;
	const flushOnFrameBytes = options.flushOnFrameBytes ?? 256 * 1024;
	const flushAfterMs = options.flushAfterMs ?? 30_000;
	const metrics = new Map<
		string,
		{
			direction: RpcPayloadDirection;
			rpc: string;
			frames: number;
			uncompressedBytes: number;
			maxUncompressedFrameBytes: number;
			serializationAndMeasurementMs: number;
		}
	>();
	let frames = 0;
	let uncompressedBytes = 0;
	let maxUncompressedFrameBytes = 0;
	let serializationAndMeasurementMs = 0;
	let flushTimer: ReturnType<typeof setTimeout> | undefined;

	const flush = (): void => {
		if (frames === 0) return;
		if (flushTimer !== undefined) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		try {
			options.onReport({
				transport: options.transport,
				frames,
				uncompressedBytes,
				maxUncompressedFrameBytes,
				serializationAndMeasurementMs,
				metrics: [...metrics.values()]
					.sort(
						(left, right) => right.uncompressedBytes - left.uncompressedBytes,
					)
					.slice(0, 20),
			});
		} catch {
			// Diagnostics must never interrupt the transport they observe.
		}
		metrics.clear();
		frames = 0;
		uncompressedBytes = 0;
		maxUncompressedFrameBytes = 0;
		serializationAndMeasurementMs = 0;
	};

	const record = (sample: RpcPayloadSample): void => {
		const key = `${sample.direction}\u0000${sample.rpc}`;
		const current = metrics.get(key) ?? {
			direction: sample.direction,
			rpc: sample.rpc,
			frames: 0,
			uncompressedBytes: 0,
			maxUncompressedFrameBytes: 0,
			serializationAndMeasurementMs: 0,
		};
		current.frames += sample.frames;
		current.uncompressedBytes += sample.bytes;
		current.maxUncompressedFrameBytes = Math.max(
			current.maxUncompressedFrameBytes,
			sample.bytes,
		);
		current.serializationAndMeasurementMs += sample.durationMs;
		metrics.set(key, current);
		frames += sample.frames;
		uncompressedBytes += sample.bytes;
		maxUncompressedFrameBytes = Math.max(
			maxUncompressedFrameBytes,
			sample.bytes,
		);
		serializationAndMeasurementMs += sample.durationMs;
		if (flushTimer === undefined) {
			flushTimer = setTimeout(flush, flushAfterMs);
			(
				flushTimer as ReturnType<typeof setTimeout> & {
					readonly unref?: () => void;
				}
			).unref?.();
		}
		if (frames >= flushEveryFrames || sample.bytes >= flushOnFrameBytes) {
			flush();
		}
	};

	return { record, flush };
};
