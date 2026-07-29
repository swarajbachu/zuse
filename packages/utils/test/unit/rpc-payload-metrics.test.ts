import { afterEach, describe, expect, it, vi } from "vitest";
import {
	makeMeasuredJsonRpcSerialization,
	makeRpcPayloadReporter,
	type RpcPayloadReport,
} from "../../src/rpc-payload-metrics.js";

describe("RPC payload metrics", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("attributes response bytes to the request tag without retaining payloads", () => {
		const reports: RpcPayloadReport[] = [];
		const reporter = makeRpcPayloadReporter({
			transport: "test",
			flushEveryFrames: 2,
			onReport: (report) => reports.push(report),
		});
		const parser = makeMeasuredJsonRpcSerialization({
			encodeDirection: "outbound",
			decodeDirection: "inbound",
			record: reporter.record,
		}).makeUnsafe();

		parser.decode(
			JSON.stringify({
				_tag: "Request",
				id: 42,
				tag: "session.events",
				payload: { sessionId: "session-secret" },
				headers: [],
			}),
		);
		parser.encode({
			_tag: "Chunk",
			requestId: 42,
			values: [{ transcript: "not retained by the reporter" }],
		});

		expect(reports).toHaveLength(1);
		expect(reports[0]).toMatchObject({
			transport: "test",
			frames: 2,
		});
		expect(reports[0]?.metrics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					direction: "outbound",
					rpc: "session.events",
					frames: 1,
				}),
				expect.objectContaining({
					direction: "inbound",
					rpc: "session.events",
					frames: 1,
				}),
			]),
		);
		expect(JSON.stringify(reports)).not.toContain("session-secret");
		expect(JSON.stringify(reports)).not.toContain("not retained");
	});

	it("flushes a large frame immediately", () => {
		const reports: RpcPayloadReport[] = [];
		const reporter = makeRpcPayloadReporter({
			transport: "test",
			flushEveryFrames: 100,
			flushOnFrameBytes: 10,
			onReport: (report) => reports.push(report),
		});

		reporter.record({
			direction: "outbound",
			rpc: "messages.list",
			bytes: 11,
			durationMs: 1,
			frames: 1,
		});

		expect(reports).toHaveLength(1);
		expect(reports[0]?.maxUncompressedFrameBytes).toBe(11);
	});

	it("flushes low-volume traffic on a timer", () => {
		vi.useFakeTimers();
		const reports: RpcPayloadReport[] = [];
		const reporter = makeRpcPayloadReporter({
			transport: "test",
			flushAfterMs: 1_000,
			onReport: (report) => reports.push(report),
		});

		reporter.record({
			direction: "inbound",
			rpc: "ping.ping",
			bytes: 5,
			durationMs: 0.1,
			frames: 1,
		});
		expect(reports).toHaveLength(0);
		vi.advanceTimersByTime(1_000);
		expect(reports).toHaveLength(1);
	});

	it("counts UTF-8 bytes without retaining or copying the encoded frame", () => {
		const reports: RpcPayloadReport[] = [];
		const reporter = makeRpcPayloadReporter({
			transport: "test",
			flushEveryFrames: 1,
			onReport: (report) => reports.push(report),
		});
		const parser = makeMeasuredJsonRpcSerialization({
			encodeDirection: "outbound",
			decodeDirection: "inbound",
			record: reporter.record,
		}).makeUnsafe();
		const message = { _tag: "Pong", value: "🙂" };
		const encoded = parser.encode(message);

		expect(typeof encoded).toBe("string");
		if (typeof encoded !== "string") throw new Error("expected JSON string");
		expect(reports[0]?.uncompressedBytes).toBe(
			new TextEncoder().encode(encoded).byteLength,
		);
	});
});
