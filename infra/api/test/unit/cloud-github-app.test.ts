import { generateKeyPairSync } from "node:crypto";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { importPKCS8, jwtVerify, SignJWT } from "jose";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
	githubInstallationCredentialForRepository,
	githubInstallationGrantForRepository,
	githubInstallCallbackForwardUrl,
	normalizeGithubPrivateKey,
} from "../../src/cloud-github-app.ts";

import {
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import { layer as configurationLayer } from "../../src/config.ts";

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
		const token = state("https://api-staging.zuse.sh");
		const result = githubInstallCallbackForwardUrl(
			token,
			123,
			"https://api.zuse.sh",
		);
		expect(result).toBe(
			`https://api-staging.zuse.sh/v1/cloud/github/callback?state=${encodeURIComponent(token)}&installation_id=123`,
		);
	});

	test("never forwards unknown issuers or callbacks already on staging", () => {
		const unknown = state("https://attacker.example");
		const staging = state("https://api-staging.zuse.sh");
		expect(
			githubInstallCallbackForwardUrl(unknown, 123, "https://api.zuse.sh"),
		).toBeNull();
		expect(
			githubInstallCallbackForwardUrl(
				staging,
				123,
				"https://api-staging.zuse.sh",
			),
		).toBeNull();
		expect(
			githubInstallCallbackForwardUrl("not-a-jwt", 123, "https://api.zuse.sh"),
		).toBeNull();
	});

	test.each([
		"https://api-staging.stuff.md",
		"https://api-staging.zuse.sh.attacker.example",
		"https://api-staging.zuse.sh/",
		"http://api-staging.zuse.sh",
	])("rejects retired and non-exact staging issuer %s", (issuer) => {
		expect(
			githubInstallCallbackForwardUrl(
				state(issuer),
				123,
				"https://api.zuse.sh",
			),
		).toBeNull();
	});
});

describe("GitHub installation failure isolation", () => {
	afterEach(() => vi.unstubAllGlobals());
	test.each([
		404, 500,
	])("handles installation status %s without hiding outages", async (status) => {
		const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const runtime = ManagedRuntime.make(
			Layer.merge(
				CloudWorkspaceStoreMemory,
				configurationLayer({
					apiIssuer: "https://api-staging.stuff.md",
					workosJwksUrl: "unused",
					workosIssuer: "unused",
					mintPrivateKey: Redacted.make("unused"),
					mintPublicKey: "unused",
					githubApp: {
						appId: "app",
						clientId: "client",
						slug: "test",
						privateKey: Redacted.make(
							privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
						),
					},
				}),
			),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.endsWith("/111/access_tokens"))
					return Response.json({ message: "Unavailable" }, { status });
				if (url.endsWith("/222/access_tokens"))
					return Response.json({
						token: "healthy-token",
						expires_at: "2099-01-01T00:00:00Z",
					});
				if (url.includes("/installation/repositories?"))
					return Response.json({
						repositories: [
							{
								full_name: "acme/repo",
								clone_url: "https://github.com/acme/repo.git",
								default_branch: "main",
								private: true,
								description: null,
								owner: {},
								updated_at: "2026-01-01T00:00:00Z",
							},
						],
					});
				throw new Error("Unexpected GitHub request");
			}),
		);
		try {
			const store = await runtime.runPromise(CloudWorkspaceStore);
			for (const installationId of [111, 222])
				await runtime.runPromise(
					store.saveGithubInstallation({
						accountId: "account",
						installationId,
						githubAccountId: installationId,
						accountLogin: "acme",
						accountType: "Organization",
						repositorySelection: "all",
						suspended: false,
						createdAtMs: 1,
						updatedAtMs: 1,
					}),
				);
			const result = await runtime.runPromise(
				githubInstallationCredentialForRepository(
					"account",
					"github.com/acme/repo",
				).pipe(Effect.result),
			);
			if (status === 404)
				expect(result).toMatchObject({
					_tag: "Success",
					success: {
						token: "healthy-token",
						expiresAtMs: Date.parse("2099-01-01T00:00:00Z"),
					},
				});
			else
				expect(result).toMatchObject({
					_tag: "Failure",
					failure: { code: "github_app_unavailable", status: 503 },
				});
		} finally {
			await runtime.dispose();
		}
	});
});
