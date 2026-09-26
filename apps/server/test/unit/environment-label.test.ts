import { expect, test } from "vitest";
import { personalizedComputerLabel } from "../../src/lan-auth/environment-label";

test("qualifies generic model names with the login name", () => {
	expect(personalizedComputerLabel("MacBook Pro", "whizzy")).toBe(
		"whizzy’s MacBook Pro",
	);
	expect(personalizedComputerLabel("Mac mini", "sam")).toBe("sam’s Mac mini");
});
test("preserves custom computer names and handles unavailable usernames", () => {
	expect(personalizedComputerLabel("Studio desk", "whizzy")).toBe(
		"Studio desk",
	);
	expect(personalizedComputerLabel("MacBook Pro", null)).toBe("MacBook Pro");
});
