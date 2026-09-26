import {
	PtyCatalog,
	PtyId,
	PtyOpenRpc,
	PtyOwnerId,
	PtyOwnership,
	PtySummary,
} from "@zuse/contracts";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
	ptyListResponse,
	resolvePtyOpenOwnership,
} from "../../src/pty/handlers.ts";

const terminal = PtySummary.make({
	ptyId: PtyId.make("catalog-terminal"),
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
const catalog = PtyCatalog.make({ terminals: [terminal], liveLimit: 7 });

describe("PTY list handler rollout", () => {
	it("preserves ownership from an older mobile wire payload", async () => {
		const payload = Schema.decodeUnknownSync(PtyOpenRpc.payloadSchema)({
			cwd: "/workspace",
			cols: 80,
			rows: 24,
			mobileOwnership: {
				ownerId: "legacy-mobile",
				label: "Shell",
				scope: "session",
			},
		});
		const ownership = await Effect.runPromise(
			resolvePtyOpenOwnership(payload.ownership, payload.mobileOwnership),
		);
		expect(ownership).toMatchObject({
			ownerId: "legacy-mobile",
			label: "Shell",
			scope: "session",
		});
	});

	it("rejects conflicting ownership aliases", async () => {
		await expect(
			Effect.runPromise(
				resolvePtyOpenOwnership(
					PtyOwnership.make({ ownerId: PtyOwnerId.make("new") }),
					PtyOwnership.make({ ownerId: PtyOwnerId.make("old") }),
				),
			),
		).rejects.toMatchObject({
			_tag: "PtySpawnError",
			reason: "Conflicting terminal ownership fields",
		});
	});
	it("returns the legacy array when policy opt-in is omitted", () => {
		expect(ptyListResponse(catalog, undefined)).toEqual([terminal]);
	});

	it("returns authoritative policy to opted-in clients", () => {
		expect(ptyListResponse(catalog, true)).toBe(catalog);
	});
});
