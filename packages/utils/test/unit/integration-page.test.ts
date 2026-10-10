import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
	INTEGRATION_PAGE_HEADERS,
	INTEGRATION_PAGE_SCRIPT_SOURCE,
	renderIntegrationPage,
} from "../../src/integration-page.ts";

describe("integration page", () => {
	test("keeps account selection self-contained", () => {
		const page = renderIntegrationPage({
			integration: "GitHub",
			title: "Choose a GitHub account",
			description: "For your QA workspace.",
			status: "Connect",
			hint: "Choose repositories on GitHub, then return to connect.",
			actions: [
				{
					label: "Use this account",
					accountName: 'test<owner>"',
					description: "Personal GitHub account",
					manageUrl: "https://github.com/settings/installations/123",
					action: "/callback",
					csrf: 'token"<>&',
				},
			],
		});
		expect(page).toContain('class="list"');
		expect(page).toContain('<span class="mark" aria-hidden="true">t</span>');
		expect(page).toContain('method="post" action="/callback"');
		expect(page).toContain('name="csrf" value="token&quot;&lt;&gt;&amp;"');
		expect(page).toContain("Use this account: test&lt;owner&gt;&quot;");
		expect(page).toContain('rel="noopener noreferrer"');
		expect(page.match(/<script/gu)).toHaveLength(2);
		expect(page).not.toMatch(
			/<img|<iframe|(?:src|href)="https?:\/\/(?!github\.com)/u,
		);
		expect(page).not.toContain("test<owner>");
		expect(page.length).toBeLessThan(65_000);
	});

	test("restricts scripts to the bundled page scripts", () => {
		expect(INTEGRATION_PAGE_HEADERS["content-security-policy"]).toContain(
			`script-src ${INTEGRATION_PAGE_SCRIPT_SOURCE}`,
		);
		expect(INTEGRATION_PAGE_HEADERS["content-security-policy"]).toContain(
			"default-src 'none'",
		);
	});

	test("renders actions as buttons when there are no accounts to choose", () => {
		const page = renderIntegrationPage({
			integration: "Slack",
			description: "Connected.",
			status: "Connected",
			hint: "Hint.",
			actions: [
				{ label: "Return to Slack", href: "slack://app" },
				{ label: "Log out", action: "/logout", csrf: "csrf" },
			],
		});
		expect(page).not.toContain('class="list"');
		expect(page).toContain('<a class="button" href="slack://app">');
		expect(page).toContain('class="button secondary" type="submit"');
	});
	test("shows GitHub avatars and nothing from other image hosts", () => {
		const page = renderIntegrationPage({
			integration: "GitHub",
			description: "For your QA workspace.",
			status: "Connect",
			hint: "",
			actions: [
				{
					label: "Use this account",
					accountName: "octocat",
					avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
					action: "https://api.test/callback",
					csrf: "token",
				},
				{
					label: "Approve on GitHub",
					accountName: "acme",
					avatarUrl: "https://evil.example/pixel.png",
					href: "https://github.com/organizations/acme/settings/installations/2",
					resumeHref: "/callback?state=resume",
				},
			],
		});
		expect(page).toContain(
			'<img class="mark" src="https://avatars.githubusercontent.com/u/1?v=4"',
		);
		expect(page).not.toContain("evil.example");
		expect(page).toContain('aria-label="Approve on GitHub: acme"');
		// Returning from GitHub resumes at the row's same-origin URL.
		expect(page).toContain('data-resume="/callback?state=resume"');
		expect(page.match(/<script/gu)).toHaveLength(3);
		const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map(
			(match) =>
				`'sha256-${createHash("sha256")
					.update(match[1] ?? "")
					.digest("base64")}'`,
		);
		for (const source of scripts)
			expect(INTEGRATION_PAGE_HEADERS["content-security-policy"]).toContain(
				source,
			);
		expect(INTEGRATION_PAGE_HEADERS["content-security-policy"]).toContain(
			"img-src https://avatars.githubusercontent.com",
		);
	});
});
