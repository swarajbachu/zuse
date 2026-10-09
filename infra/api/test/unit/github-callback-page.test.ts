import { describe, expect, test } from "vitest";

import {
	githubCallbackPageHeaders,
	renderGithubConnectedPage,
} from "../../src/github-callback-page.ts";

describe("GitHub callback page", () => {
	test("renders a flat, self-contained connection page", () => {
		const page = renderGithubConnectedPage('acme<script>alert("x")</script>');

		expect(page).toContain("GitHub connected · Zuse");
		expect(page).toContain("<h1>GitHub connected</h1>");
		expect(page).toContain('<a class="button" href="zuse://">Open Zuse</a>');
		expect(page).not.toContain("stamp-shell");
		expect(page).not.toContain("<script>alert");
		expect(page).toContain("&lt;script&gt;");
		expect(page).not.toMatch(/(?:src|href)="https?:/u);
		expect(page).toContain("prefers-color-scheme:dark");
	});

	test("keeps the callback uncacheable and strips referrers", () => {
		expect(githubCallbackPageHeaders["cache-control"]).toBe("no-store");
		expect(githubCallbackPageHeaders["referrer-policy"]).toBe("no-referrer");
		expect(githubCallbackPageHeaders["content-security-policy"]).toMatch(
			/script-src 'sha256-[^']+'/u,
		);
	});
});
