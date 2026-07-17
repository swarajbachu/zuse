import { describe, expect, test } from "vitest";
import { resolveFileIcon } from "../../src/components/file-icon.tsx";

describe("resolveFileIcon", () => {
	test.each([
		["src/app.tsx", "react"],
		["src/index.ts", "typescript"],
		["README.md", "markdown"],
		["Dockerfile", "docker"],
		["data.sqlite", "database"],
	] as const)("maps %s to the complete icon set", (path, token) => {
		expect(resolveFileIcon(path).token).toBe(token);
	});
});
