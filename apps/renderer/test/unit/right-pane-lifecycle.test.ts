import { describe, expect, it } from "vitest";

import { makeCommittedAuthority } from "../../src/lib/committed-authority.ts";
import { shouldMountRightPane } from "../../src/shell/right-pane-lifecycle.ts";

describe("right-pane lifecycle", () => {
	it("keeps browser command handling mounted while the dock is collapsed", () => {
		expect(shouldMountRightPane(false)).toBe(true);
		expect(shouldMountRightPane(true)).toBe(true);
	});

	it("keeps A authoritative when React computes B without committing it", () => {
		const authority = makeCommittedAuthority("chat-a");

		// Computing the next render's identity is deliberately pure. The layout
		// phase is the only caller allowed to commit it.
		const speculativeIdentity = "chat-b";
		expect(authority.current()).toBe("chat-a");
		expect(authority.isCurrent(speculativeIdentity)).toBe(false);

		authority.commit(speculativeIdentity);
		expect(authority.current()).toBe("chat-b");
	});
});
