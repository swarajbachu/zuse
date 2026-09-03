import { generateKeyPairSync } from "node:crypto";

import { importPKCS8, jwtVerify, SignJWT } from "jose";
import { describe, expect, test } from "vitest";

import {
	githubInstallationGrantForRepository,
	githubInstallCallbackForwardUrl,
	normalizeGithubPrivateKey,
} from "../../src/cloud-github-app.ts";

describe("GitHub App repository credentials", () => {
	const grant = {
		installationId: 123,
		token: "installation-token",
		expiresAt: "2099-01-01T00:00:00Z",
		repositories: [
			{
				fullName: "Acme/Example",
				cloneUrl: "https://github.com/Acme/Example.git",
				defaultBranch: "main",
				private: true,
				updatedAt: "2099-01-01T00:00:00Z",
			},
		],
	};

	test("selects only an installation that grants the workspace repository", () => {
		expect(
			githubInstallationGrantForRepository([grant], "github.com/acme/example"),
		).toBe(grant);
		expect(
			githubInstallationGrantForRepository([grant], "github.com/acme/other"),
		).toBeNull();
	});
});

describe("GitHub App private keys", () => {
	test("normalizes GitHub's PKCS#1 download for jose", async () => {
		const { privateKey, publicKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
		});
		const githubPem = privateKey.export({
			format: "pem",
			type: "pkcs1",
		}) as string;

		const normalized = normalizeGithubPrivateKey(githubPem);
		expect(normalized).toContain("BEGIN PRIVATE KEY");
		expect(normalized).not.toContain("BEGIN RSA PRIVATE KEY");

		const imported = await importPKCS8(normalized, "RS256");
		const jwt = await new SignJWT({})
			.setProtectedHeader({ alg: "RS256" })
			.setIssuer("test-client-id")
			.setExpirationTime("1m")
			.sign(imported);
		await expect(jwtVerify(jwt, publicKey)).resolves.toMatchObject({
			payload: { iss: "test-client-id" },
		});
	});
});

describe("GitHub App installation callback routing", () => {
	const state = (issuer: string) =>
		`${Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString("base64url")}.${Buffer.from(JSON.stringify({ iss: issuer })).toString("base64url")}.signature`;

	test("forwards an exact staging issuer from the production callback", () => {
		const token = state("https://api-staging.stuff.md");
		const result = githubInstallCallbackForwardUrl(
			token,
			123,
			"https://api.zuse.sh",
		);
		expect(result).toBe(
			`https://api-staging.stuff.md/v1/cloud/github/callback?state=${encodeURIComponent(token)}&installation_id=123`,
		);
	});

	test("never forwards unknown issuers or callbacks already on staging", () => {
		const unknown = state("https://attacker.example");
		const staging = state("https://api-staging.stuff.md");
		expect(
			githubInstallCallbackForwardUrl(unknown, 123, "https://api.zuse.sh"),
		).toBeNull();
		expect(
			githubInstallCallbackForwardUrl(
				staging,
				123,
				"https://api-staging.stuff.md",
			),
		).toBeNull();
		expect(
			githubInstallCallbackForwardUrl("not-a-jwt", 123, "https://api.zuse.sh"),
		).toBeNull();
	});
});
