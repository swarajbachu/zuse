import { describe, expect, test, vi } from "vitest";

import { returnToInbox } from "../../../src/lib/connection-navigation";

describe("connection navigation", () => {
	test("collapses pairing, manual, and remote entry flows into the root inbox", () => {
		for (const source of ["paired", "manual", "relay"]) {
			const navigator = {
				dismissAll: vi.fn(),
				replace: vi.fn(),
			};
			returnToInbox(navigator);
			expect(navigator.dismissAll, source).toHaveBeenCalledOnce();
			expect(navigator.replace, source).toHaveBeenCalledWith("/");
		}
	});
});
