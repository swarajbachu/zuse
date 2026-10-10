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
		expect(page).toContain("Switch back to your open Zuse window");
		expect(page).not.toContain("zuse://");
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

test("approval polling can only connect to this API under the page CSP", async () => {
	const { githubApprovalPageHeaders, renderGithubSetupPage } = await import(
		"../../src/github-callback-page.ts"
	);
	expect(githubApprovalPageHeaders["content-security-policy"]).toContain(
		"connect-src 'self'",
	);
	expect(githubApprovalPageHeaders["referrer-policy"]).toBe("strict-origin");
	const html = renderGithubSetupPage(true, "https://api.test/resume", {
		callback: "https://api.test/check",
		state: '"><script>unsafe</script>',
	});
	expect(html).toContain("data-approval-check");
	expect(html).not.toContain("<script>unsafe</script>");
});
