import {
	PtyOpenRpc,
	PtyOpenToken,
	PtyOwnerId,
	PtyOwnership,
} from "@zuse/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { mobileTerminalOpenOwnership } from "~/rpc/terminal-actions";

describe("mobile terminal RPC actions", () => {
	it("constructs ownership that the pty.open encoder accepts", () => {
		const ownership = mobileTerminalOpenOwnership(
			PtyOwnerId.make("mobile-owner"),
			PtyOpenToken.make("mobile-terminal-slot"),
			"Project shell",
			true,
		);

		expect(() =>
			Schema.encodeSync(PtyOpenRpc.payloadSchema)({
				cwd: "/workspace",
				cols: 80,
				rows: 24,
				ownership,
			}),
		).not.toThrow();
		expect(ownership).toBeInstanceOf(PtyOwnership);
	});
});
