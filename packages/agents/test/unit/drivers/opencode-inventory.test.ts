import { describe, expect, it } from "vitest";

import { isUsableOpencodeInventoryModel } from "../../../src/drivers/opencode.ts";

describe("OpenCode model inventory", () => {
	it("removes retired Opus 4.5 while keeping current tool-capable models", () => {
		expect(
			isUsableOpencodeInventoryModel({
				id: "claude-opus-4-5",
				name: "Claude Opus 4.5",
			}),
		).toBe(false);
		expect(
			isUsableOpencodeInventoryModel({
				id: "claude-opus-5",
				name: "Claude Opus 5",
				capabilities: { toolcall: true },
			}),
		).toBe(true);
	});
});
