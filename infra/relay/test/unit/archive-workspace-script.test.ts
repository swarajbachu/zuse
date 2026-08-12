import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const script = readFileSync(
	new URL("../../../cloud-sandboxes/archive-workspace.sh", import.meta.url),
	"utf8",
);

describe("cloud workspace archive script", () => {
	test("quiesces both legacy and versioned runtime commands before bundling", () => {
		expect(script).toContain("[z]use serve");
		expect(script).toContain("[/]opt/zuse/current/bin.mjs serve");
	});
});
