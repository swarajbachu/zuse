import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
	PtyCatalog,
	PtyDataEvent,
	PtyListRpc,
	PtyOpenRpc,
	PtyOpenToken,
	PtyOutputRpc,
	PtyOwnerId,
	PtyOwnership,
	PtyResizeRpc,
	PtyRestartRpc,
	PtySummary,
} from "../../src/index.ts";

describe("PTY lifecycle contracts", () => {
	it("brands and validates the catalog owner at every wire boundary", () => {
		expect(Schema.decodeUnknownSync(PtyOwnerId)(" desktop-owner ")).toBe(
			"desktop-owner",
		);
		expect(() => Schema.decodeUnknownSync(PtyOwnerId)("   ")).toThrow();
		expect(() =>
			Schema.decodeUnknownSync(PtyOwnership)({ ownerId: "   " }),
		).toThrow();
	});

	it("accepts a bounded stable open token and exposes it in the catalog", () => {
		const ownership = Schema.decodeUnknownSync(PtyOwnership)({
			ownerId: "desktop-owner",
			openToken: "logical-terminal-1",
		});
		expect(ownership.openToken).toBe("logical-terminal-1");

		const summary = Schema.decodeUnknownSync(PtySummary)({
			ptyId: "server-pty-1",
			cwd: "/workspace",
			label: null,
			scope: "session",
			status: "running",
			cols: 80,
			rows: 24,
			processEpoch: "epoch-1",
			latestOutputSequence: 0,
			openToken: "logical-terminal-1",
		});
		expect(summary.openToken).toBe("logical-terminal-1");
	});

	it("rejects empty and oversized open tokens at the RPC boundary", () => {
		expect(() => Schema.decodeUnknownSync(PtyOpenToken)("   ")).toThrow();
		expect(() =>
			Schema.decodeUnknownSync(PtyOpenToken)("x".repeat(129)),
		).toThrow();
		expect(
			Schema.decodeUnknownSync(PtyOpenToken)("x".repeat(128)),
		).toHaveLength(128);
	});

	it("decodes a legacy catalog summary with a null open token", () => {
		const summary = Schema.decodeUnknownSync(PtySummary)({
			ptyId: "legacy-server-pty",
			cwd: "/workspace",
			label: null,
			scope: "session",
			status: "running",
			cols: 80,
			rows: 24,
			latestOutputSequence: 0,
		});
		expect(summary.openToken).toBeNull();
		expect(summary.processEpoch).toBe("legacy");
	});

	it("keeps process epochs compatible in both protocol directions", () => {
		const legacyOpen = Schema.decodeUnknownSync(PtyOpenRpc.successSchema)({
			ptyId: "legacy-open-pty",
		});
		expect(legacyOpen.processEpoch).toBe("legacy");

		const legacyEvent = Schema.decodeUnknownSync(PtyDataEvent)({
			_tag: "data",
			sequence: 1,
			bytes: "legacy output",
		});
		expect(legacyEvent.processEpoch).toBe("legacy");

		const legacyOutputRequest = Schema.decodeUnknownSync(
			PtyOutputRpc.payloadSchema,
		)({
			ptyId: "legacy-output-pty",
			afterSequence: 0,
		});
		expect(legacyOutputRequest.processEpoch).toBeUndefined();
	});

	it("keeps PTY catalog policy opt-in across mixed client/server versions", () => {
		const legacyRequest = Schema.decodeUnknownSync(PtyListRpc.payloadSchema)({
			ownerId: "desktop-owner",
		});
		expect(legacyRequest.includePolicy).toBeUndefined();
		expect(
			Schema.decodeUnknownSync(PtyListRpc.payloadSchema)({
				ownerId: "desktop-owner",
				includePolicy: true,
			}).includePolicy,
		).toBe(true);
		const legacyPayloadSchema = Schema.Struct({ ownerId: PtyOwnerId });
		expect(
			Schema.decodeUnknownSync(legacyPayloadSchema)({
				ownerId: "desktop-owner",
				includePolicy: true,
			}),
		).toEqual({ ownerId: "desktop-owner" });

		const terminal = Schema.decodeUnknownSync(PtySummary)({
			ptyId: "server-pty-1",
			cwd: "/workspace",
			label: null,
			scope: "session",
			status: "running",
			cols: 80,
			rows: 24,
			processEpoch: "epoch-1",
			latestOutputSequence: 0,
			openToken: null,
		});
		expect(
			Schema.decodeUnknownSync(PtyListRpc.successSchema)([terminal]),
		).toEqual([terminal]);
		expect(
			Schema.decodeUnknownSync(PtyListRpc.successSchema)(
				PtyCatalog.make({ terminals: [terminal], liveLimit: 7 }),
			),
		).toMatchObject({ terminals: [terminal], liveLimit: 7 });
	});

	it("accepts an epoch precondition for idempotent restart replay", () => {
		const request = Schema.decodeUnknownSync(PtyRestartRpc.payloadSchema)({
			ptyId: "restart-pty",
			ownerId: "desktop-owner",
			expectedProcessEpoch: "epoch-before-restart",
		});
		expect(request.expectedProcessEpoch).toBe("epoch-before-restart");
	});

	it("rejects dimensions and output cursors that cannot represent PTY state", () => {
		const open = (cols: number, rows: number) =>
			Schema.decodeUnknownSync(PtyOpenRpc.payloadSchema)({
				cwd: "/workspace",
				cols,
				rows,
			});
		const resize = (cols: number, rows: number) =>
			Schema.decodeUnknownSync(PtyResizeRpc.payloadSchema)({
				ptyId: "server-pty-1",
				cols,
				rows,
			});

		for (const invalidDimension of [0, -1, 80.5, 65_536]) {
			expect(() => open(invalidDimension, 24)).toThrow();
			expect(() => resize(80, invalidDimension)).toThrow();
		}
		expect(open(65_535, 1)).toMatchObject({ cols: 65_535, rows: 1 });

		for (const invalidSequence of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() =>
				Schema.decodeUnknownSync(PtyOutputRpc.payloadSchema)({
					ptyId: "server-pty-1",
					afterSequence: invalidSequence,
				}),
			).toThrow();
			expect(() =>
				Schema.decodeUnknownSync(PtyDataEvent)({
					_tag: "data",
					processEpoch: "epoch-1",
					sequence: invalidSequence,
					bytes: "output",
				}),
			).toThrow();
		}
	});
});
