import { generateKeyPairSync } from "node:crypto";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { importPKCS8, jwtVerify, SignJWT } from "jose";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
	completeGithubInstallation,
	githubAuthorizationCallback,
	githubAuthorizationUrl,
	githubInstallationCredentialForRepository,
	githubInstallationGrantForRepository,
	githubInstallCallbackForwardUrl,
	makeGithubInstallUrl,
	normalizeGithubPrivateKey,
} from "../../src/cloud-github-app.ts";

import {
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import { layer as configurationLayer } from "../../src/config.ts";
import { ApiStoreMemory } from "../../src/store.ts";

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
	test.each([
		["account", "User"],
		["organization:team", "User"],
		["account", "Organization"],
		["organization:team", "Organization"],
	])("links to %s from GitHub %s without an install callback, only after explicit selection", async (ownerId, accountType) => {
		const keys = generateKeyPairSync("ed25519");
		const app = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const runtime = ManagedRuntime.make(
			Layer.mergeAll(
				CloudWorkspaceStoreMemory,
				ApiStoreMemory,
				configurationLayer({
					apiIssuer: "https://api-staging.zuse.sh",
					workosJwksUrl: "unused",
					workosIssuer: "unused",
					workosApiKey: Redacted.make("workos-test"),
					organizationWorkspacesEnabled: true,
					cloudDataEncryptionKey: Redacted.make(
						Buffer.alloc(32, 7).toString("base64url"),
					),
					mintPrivateKey: Redacted.make(
						JSON.stringify(keys.privateKey.export({ format: "jwk" })),
					),
					mintPublicKey: JSON.stringify(
						keys.publicKey.export({ format: "jwk" }),
					),
					githubApp: {
						appId: "1",
						clientId: "client",
						clientSecret: Redacted.make("secret"),
						slug: "zuse",
						privateKey: Redacted.make(
							app.privateKey
								.export({ format: "pem", type: "pkcs8" })
								.toString(),
						),
					},
				}),
			),
		);
		const installation = {
			id: 123,
			app_id: 1,
			account: { id: 7, login: "octocat", type: accountType },
			repository_selection: "selected",
			suspended_at: null,
		};
		let memberActive = true;
		let installed = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.includes("/user_management/organization_memberships?"))
					return Response.json({
						data: memberActive
							? [
									{
										id: "membership",
										organization_id: "team",
										user_id: "account",
										status: "active",
										role: { slug: "admin" },
									},
								]
							: [],
						list_metadata: { after: null },
					});
				if (url.endsWith("/organizations/team"))
					return Response.json({ id: "team", name: "Example team" });
				if (url.endsWith("/login/oauth/access_token"))
					return Response.json({ access_token: "user-token" });
				if (url.endsWith("/user"))
					return Response.json({ id: 7, login: "octocat", name: "Octo Cat" });
				if (url.includes("/user/installations?"))
					return Response.json(
						!installed
							? { installations: [] }
							: {
									installations: [
										installation,
										{
											...installation,
											id: 456,
											account: { id: 8, login: "other-person", type: "User" },
										},
										{
											...installation,
											id: 789,
											account: {
												id: 9,
												login: "unowned-org",
												type: "Organization",
											},
										},
									],
								},
					);
				if (url.includes("/memberships/orgs/"))
					return Response.json({
						role: url.endsWith("/octocat") ? "admin" : "member",
						state: "active",
					});
				if (url.endsWith("/app/installations/123"))
					return Response.json(installation);
				throw new Error("Unexpected GitHub request");
			}),
		);
		try {
			const installUrl = await runtime.runPromise(
				makeGithubInstallUrl(ownerId, "account"),
			);
			const start = await runtime.runPromise(
				githubAuthorizationCallback(
					new Request(
						githubAuthorizationUrl(installUrl, "https://api-staging.zuse.sh"),
					),
				),
			);
			const cookie = start.headers.get("set-cookie")?.split(";")[0] ?? "";
			const authorize = new URL(start.headers.get("location") ?? "");
			expect(authorize.pathname).toBe("/login/oauth/authorize");
			const callback = new URL(
				authorize.searchParams.get("redirect_uri") ?? "",
			);
			callback.searchParams.set(
				"state",
				authorize.searchParams.get("state") ?? "",
			);
			callback.searchParams.set("code", "one-use-code");
			const rejected = await runtime.runPromise(
				githubAuthorizationCallback(new Request(callback)).pipe(Effect.result),
			);
			expect(rejected).toMatchObject({
				failure: { code: "invalid_github_browser_state" },
			});
			const fresh = await runtime.runPromise(
				githubAuthorizationCallback(
					new Request(callback, { headers: { cookie } }),
				),
			);
			expect(fresh.status).toBe(302);
			expect(new URL(fresh.headers.get("location") ?? "").pathname).toBe(
				"/apps/zuse/installations/new",
			);
			installed = true;
			callback.searchParams.set("code", "after-install-code");
			const chooser = await runtime.runPromise(
				githubAuthorizationCallback(
					new Request(callback, { headers: { cookie } }),
				),
			);
			const html = await chooser.text();
			expect(html).toContain("Use this account: octocat");
			expect(html).toContain("Manage repository access");
			expect(html).toContain('target="_blank" rel="noopener noreferrer"');
			expect(html).not.toContain("other-person");
			expect(html).not.toContain("unowned-org");
			expect(html).not.toContain("user-token");
			const store = await runtime.runPromise(CloudWorkspaceStore);
			expect(
				await runtime.runPromise(store.listGithubInstallations(ownerId)),
			).toEqual([]);
			expect(await runtime.runPromise(store.getGithubUser(ownerId))).toBeNull();
			const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
			const select = () =>
				new Request(callback.origin + callback.pathname, {
					method: "POST",
					headers: { cookie, origin: callback.origin },
					body: new URLSearchParams({ csrf }),
				});
			if (ownerId.startsWith("organization:")) {
				expect(html).toContain("Example team");
				memberActive = false;
				const removed = await runtime.runPromise(
					githubAuthorizationCallback(select()).pipe(Effect.result),
				);
				expect(removed).toMatchObject({
					failure: { code: "organization_access_denied" },
				});
				memberActive = true;
			}
			const crossOrigin = select();
			crossOrigin.headers.set("origin", "https://attacker.example");
			expect(
				await runtime.runPromise(
					githubAuthorizationCallback(crossOrigin).pipe(Effect.result),
				),
			).toMatchObject({ failure: { code: "invalid_github_install_state" } });
			const connected = await runtime.runPromise(
				githubAuthorizationCallback(select()),
			);
			expect(await connected.text()).toContain("octocat is connected");
			expect(connected.headers.get("set-cookie")).toContain("Max-Age=0");
			expect(
				await runtime.runPromise(store.getGithubUser(ownerId)),
			).toMatchObject({
				login: "octocat",
				name: "Octo Cat",
				email: "7+octocat@users.noreply.github.com",
			});
			expect(
				await runtime.runPromise(store.getGithubUser("other-account")),
			).toBeNull();
			expect(
				await runtime.runPromise(store.listGithubInstallations(ownerId)),
			).toHaveLength(1);
			expect(
				await runtime.runPromise(
					store.listGithubInstallations("other-account"),
				),
			).toEqual([]);
			// Idempotent duplicate form submission never makes duplicate installations.
			await runtime.runPromise(githubAuthorizationCallback(select()));
			expect(
				await runtime.runPromise(store.listGithubInstallations(ownerId)),
			).toHaveLength(1);
		} finally {
			await runtime.dispose();
		}
	});
	test("an installation ID and install state alone cannot link an unverified GitHub account", async () => {
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		const runtime = ManagedRuntime.make(
			Layer.merge(
				CloudWorkspaceStoreMemory,
				configurationLayer({
					apiIssuer: "https://api-staging.zuse.sh",
					workosJwksUrl: "unused",
					workosIssuer: "unused",
					mintPrivateKey: Redacted.make(
						JSON.stringify(privateKey.export({ format: "jwk" })),
					),
					mintPublicKey: JSON.stringify(publicKey.export({ format: "jwk" })),
					githubApp: {
						appId: "app",
						slug: "test",
						privateKey: Redacted.make("unused"),
					},
				}),
			),
		);
		try {
			const url = new URL(
				await runtime.runPromise(makeGithubInstallUrl("account")),
			);
			const state = url.searchParams.get("state") ?? "";
			const result = await runtime.runPromise(
				completeGithubInstallation(state, 123).pipe(Effect.result),
			);
			expect(result).toMatchObject({
				_tag: "Failure",
				failure: { code: "invalid_github_install_state" },
			});
		} finally {
			await runtime.dispose();
		}
	});
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
