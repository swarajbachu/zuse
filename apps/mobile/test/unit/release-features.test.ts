import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { mobileReleaseFeatures } from "../../src/lib/release-features";

describe("mobile release feature boundaries", () => {
	test("keeps unfinished features disabled", () => {
		expect(mobileReleaseFeatures).toEqual({
			terminal: false,
			voice: false,
			usage: false,
		});
	});
	test("guards direct routes before mounting their effects", () => {
		for (const path of [
			"usage.tsx",
			"developer-tools.tsx",
			"c/[conn]/session/[sessionId]/terminal.tsx",
		]) {
			const source = readFileSync(`${process.cwd()}/app/${path}`, "utf8");
			expect(source).toContain("mobileReleaseFeatures.");
			expect(source).toContain('<Redirect href="/"');
		}
	});
	test("removes settings links and gates recording at the parent", () => {
		const settings = readFileSync(
			`${process.cwd()}/src/components/settings-screen.tsx`,
			"utf8",
		);
		expect(settings).not.toContain('router.push("/usage")');
		expect(settings).not.toContain('router.push("/developer-tools")');
		const composer = readFileSync(
			`${process.cwd()}/src/components/composer.tsx`,
			"utf8",
		);
		expect(composer).toContain("mobileReleaseFeatures.voice ?");
	});
});
