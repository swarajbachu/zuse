import { PtyCatalog, PtyId, PtySummary } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import { ptyListResponse } from "../../src/pty/handlers.ts";

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
	it("returns the legacy array when policy opt-in is omitted", () => {
		expect(ptyListResponse(catalog, undefined)).toEqual([terminal]);
	});

	it("returns authoritative policy to opted-in clients", () => {
		expect(ptyListResponse(catalog, true)).toBe(catalog);
	});
});
