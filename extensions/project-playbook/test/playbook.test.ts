import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parsePlaybook } from "../playbook.ts";

it("extracts sections with source lines and leaves HTML inert as text", () => {
	const sections = parsePlaybook(
		readFileSync(new URL("../fixtures/procedure.md", import.meta.url), "utf8"),
		"docs/procedure.md",
	);
	expect(sections.map((item) => item.title)).toEqual(["Deploy", "Recovery"]);
	expect(sections[1]?.subtitle).toBe("docs/procedure.md:3");
	expect(sections[1]?.text).toContain("<script>");
	expect(sections[1]?.text).toContain("# This is a shell comment");
});
it("handles empty files and heading-free notes", () => {
	expect(parsePlaybook("", "empty.md")).toEqual([]);
	expect(parsePlaybook("A note", "note.md")[0]?.text).toBe(
		"Source: note.md:1\n\nA note",
	);
});
