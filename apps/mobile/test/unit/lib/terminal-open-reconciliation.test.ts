import { PtyId, PtyOpenToken, PtySummary } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	findTerminalForOpenToken,
	terminalOpenFailureMessage,
} from "~/lib/terminal-open-reconciliation";

describe("mobile terminal open reconciliation", () => {
	it("recovers the exact logical terminal after an open response is lost", () => {
		const wanted = PtyOpenToken.make("mobile-logical-terminal");
		const summaries = [
			PtySummary.make({
				ptyId: PtyId.make("other-pty"),
				cwd: "/workspace",
				label: "Shell",
				scope: "session",
				status: "running",
				cols: 80,
				rows: 24,
				processEpoch: "other-epoch",
				latestOutputSequence: 0,
				openToken: PtyOpenToken.make("other-logical-terminal"),
			}),
			PtySummary.make({
				ptyId: PtyId.make("wanted-pty"),
				cwd: "/workspace",
				label: "Shell",
				scope: "session",
				status: "running",
				cols: 80,
				rows: 24,
				processEpoch: "wanted-epoch",
				latestOutputSequence: 0,
				openToken: wanted,
			}),
		];

		expect(findTerminalForOpenToken(summaries, wanted)?.ptyId).toBe(
			"wanted-pty",
		);
		expect(
			findTerminalForOpenToken(
				summaries,
				PtyOpenToken.make("missing-logical-terminal"),
			),
		).toBeUndefined();
	});

	it("uses shared owner-cap copy and preserves mobile-specific failures", () => {
		expect(
			terminalOpenFailureMessage({
				_tag: "PtyOwnerLimitError",
				ownerId: "mobile-device",
				limit: 4,
			}),
		).toBe("Terminal limit reached (4). Close a terminal, then retry.");
		expect(
			terminalOpenFailureMessage({
				_tag: "PtyOpenConflictError",
			}),
		).toBe(
			"This terminal conflicts with an existing process. Close it, then reopen.",
		);
	});
});
