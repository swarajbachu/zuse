import { describe, expect, it } from "vitest";
import { sortDirection } from "./agents-table";

describe("sortDirection", () => {
	it("reports A to Z columns as ascending until reversed", () => {
		expect(sortDirection({ key: "name", reverse: false })).toBe("ascending");
		expect(sortDirection({ key: "name", reverse: true })).toBe("descending");
		expect(sortDirection({ key: "category", reverse: false })).toBe(
			"ascending",
		);
	});

	it("reports ranked columns as descending until reversed", () => {
		expect(sortDirection({ key: "reputation", reverse: false })).toBe(
			"descending",
		);
		expect(sortDirection({ key: "since", reverse: true })).toBe("ascending");
		expect(sortDirection({ key: "cloud", reverse: false })).toBe("descending");
	});
});
