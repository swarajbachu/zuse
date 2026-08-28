import { describe, expect, test } from "vitest";

import {
	githubCallbackPageHeaders,
	renderGithubConnectedPage,
} from "../../src/github-callback-page.ts";

describe("GitHub callback page", () => {
	test("renders the successful installation as a self-contained integration stamp", () => {
		const page = renderGithubConnectedPage(
			'acme<script>alert("x")</script>',
			Date.parse("2026-08-20T23:54:00.000Z"),
		);

		expect(page).toContain("GitHub connected · Zuse");
		expect(page).toContain("Zuse · Integration");
		expect(page).toContain("Connected<br>2026.08.20");
		expect(page).toContain("ZS-20260820-2354");
		expect(page).not.toContain("<script>alert");
		expect(page).toContain("&lt;script&gt;");
		expect(page).not.toMatch(/(?:src|href)="https?:/u);
		expect(page).toContain("prefers-color-scheme:dark");
		expect(page).toContain("prefers-reduced-motion:reduce");
	});

	test("keeps the callback uncacheable and strips referrers", () => {
		expect(githubCallbackPageHeaders["cache-control"]).toBe("no-store");
		expect(githubCallbackPageHeaders["referrer-policy"]).toBe("no-referrer");
	});
});
