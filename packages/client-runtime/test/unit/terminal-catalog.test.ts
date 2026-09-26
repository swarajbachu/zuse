import { PtyCatalog, PtyId, PtySummary } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	normalizeTerminalCatalog,
	terminalOwnerLimitFailureMessage,
} from "../../src/terminal-catalog.ts";

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

describe("terminal catalog compatibility", () => {
	it("normalizes legacy arrays without guessing a policy limit", () => {
		expect(normalizeTerminalCatalog([terminal])).toEqual({
			terminals: [terminal],
			liveLimit: null,
		});
	});

	it("preserves server-authoritative catalog policy", () => {
		expect(
			normalizeTerminalCatalog(
				PtyCatalog.make({ terminals: [terminal], liveLimit: 7 }),
			),
		).toEqual({ terminals: [terminal], liveLimit: 7 });
	});

	it("owns the cross-client recovery copy for owner-cap failures", () => {
		expect(
			terminalOwnerLimitFailureMessage({
				_tag: "PtyOwnerLimitError",
				limit: 4,
			}),
		).toBe("Terminal limit reached (4). Close a terminal, then retry.");
		expect(terminalOwnerLimitFailureMessage(new Error("offline"))).toBeNull();
	});
});
