import { generateKeyPairSync } from "node:crypto";
import { Layer, ManagedRuntime, Redacted } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";
import { openApiString, sealApiString } from "../../src/api-sealing.ts";
import {
	disconnectGithubInstallation,
	disconnectGithubUser,
	exchangeGithubUserToken,
	githubUserCredential,
	githubUserIdentity,
	prepareGithubUserAuthorization,
} from "../../src/cloud-github-user.ts";
import {
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import { layer } from "../../src/config.ts";

const appKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
	.privateKey.export({ format: "pem", type: "pkcs8" })
	.toString();
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const runtimeForTest = () =>
	ManagedRuntime.make(
		Layer.merge(
			CloudWorkspaceStoreMemory,
			layer({
				apiIssuer: "https://api.zuse.sh",
				workosJwksUrl: "unused",
				workosIssuer: "unused",
				mintPrivateKey: Redacted.make(
					JSON.stringify(privateKey.export({ format: "jwk" })),
				),
				mintPublicKey: JSON.stringify(publicKey.export({ format: "jwk" })),
				cloudDataEncryptionKey: Redacted.make(
					Buffer.alloc(32, 7).toString("base64url"),
				),
				githubApp: {
					appId: "app",
					slug: "zuse",
					clientId: "client",
					clientSecret: Redacted.make("secret"),
					privateKey: Redacted.make(appKey),
				},
			}),
		),
	);
const tokenResponse = {
	access_token: "ghu_new",
	expires_in: 28800,
	refresh_token: "ghr_new",
	refresh_token_expires_in: 15897600,
};

afterEach(() => vi.unstubAllGlobals());
describe("cloud GitHub user identity", () => {
	test.each([
		{ profileName: "Octo Cat", commitName: "Octo Cat" },
		{ profileName: "Octo <Cat>", commitName: "octocat" },
		{ profileName: null, commitName: "octocat" },
	])("authorization prepares account-bound encrypted credentials with commit name $commitName", async ({
		profileName,
		commitName,
	}) => {
		const runtime = runtimeForTest();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				url.includes("access_token")
					? Response.json(tokenResponse)
					: Response.json({ id: 123, login: "octocat", name: profileName }),
			),
		);
		try {
			const credentials = await runtime.runPromise(
				exchangeGithubUserToken({ code: "code" }),
			);
			const prepared = await runtime.runPromise(
				prepareGithubUserAuthorization("account", credentials),
			);
			expect(prepared.authorization).toMatchObject({
				login: "octocat",
				name: commitName,
				email: "123+octocat@users.noreply.github.com",
			});
			expect(prepared.authorization.sealedCredentials).not.toContain("ghu_new");
			expect(prepared.authorization.sealedCredentials).not.toContain("ghr_new");
			expect(
				await runtime.runPromise(githubUserIdentity("account")),
			).toBeUndefined();
			expect(
				JSON.parse(
					await runtime.runPromise(
						openApiString(
							"github-user\naccount",
							prepared.authorization.sealedCredentials,
						),
					),
				),
			).toMatchObject({ accessToken: "ghu_new", refreshToken: "ghr_new" });
			await expect(
				runtime.runPromise(
					openApiString(
						"github-user\nother",
						prepared.authorization.sealedCredentials,
					),
				),
			).rejects.toThrow();
		} finally {
			await runtime.dispose();
		}
	});

	test("parallel workspaces refresh once and keep the rotated token when repository access fails", async () => {
		const runtime = runtimeForTest();
		let refreshes = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				if (url.includes("access_token")) {
					refreshes++;
					await new Promise((resolve) => setTimeout(resolve, 5));
					return Response.json(tokenResponse);
				}
				expect(url).toBe(
					"https://api.github.com/applications/client/token/scoped",
				);
				const body = JSON.parse(String(init.body));
				expect(body).toEqual({
					access_token: "ghu_new",
					target: "acme",
					repositories: [body.repositories[0]],
				});
				if (body.repositories[0] === "denied")
					return Response.json({}, { status: 404 });
				expect(body.repositories).toEqual(["repo"]);
				return Response.json({
					token: "ghu_scoped",
					expires_at: new Date(Date.now() + 3600000).toISOString(),
				});
			}),
		);
		try {
			const store = await runtime.runPromise(CloudWorkspaceStore);
			await runtime.runPromise(
				store.saveGithubUser({
					accountId: "account",
					login: "octocat",
					name: "Octo",
					email: "123+octocat@users.noreply.github.com",
					sealedCredentials: await runtime.runPromise(
						sealApiString(
							"github-user\naccount",
							JSON.stringify({
								accessToken: "old",
								expiresAtMs: Date.now() - 1,
								refreshToken: "refresh",
								refreshExpiresAtMs: Date.now() + 60000,
							}),
						),
					),
				}),
			);
			await runtime.runPromise(
				store.saveGithubInstallation({
					accountId: "account",
					installationId: 99,
					githubAccountId: 100,
					accountLogin: "acme",
					accountType: "Organization",
					repositorySelection: "selected",
					suspended: false,
					createdAtMs: 0,
					updatedAtMs: 0,
				}),
			);
			const results = await Promise.allSettled([
				runtime.runPromise(
					githubUserCredential("account", "github.com/acme/denied"),
				),
				runtime.runPromise(
					githubUserCredential("account", "github.com/acme/repo"),
				),
			]);
			expect(results[0].status).toBe("rejected");
			expect(results[1]).toMatchObject({
				status: "fulfilled",
				value: { token: "ghu_scoped" },
			});
			expect(refreshes).toBe(1);
			const stored = await runtime.runPromise(store.getGithubUser("account"));
			expect(
				JSON.parse(
					await runtime.runPromise(
						openApiString(
							"github-user\naccount",
							stored?.sealedCredentials ?? "",
						),
					),
				).refreshToken,
			).toBe("ghr_new");
		} finally {
			await runtime.dispose();
		}
	});
	test("missing authorization returns no credential; expired authorization fails instead of falling back", async () => {
		const runtime = runtimeForTest();
		try {
			expect(
				await runtime.runPromise(
					githubUserCredential("account", "github.com/acme/repo"),
				),
			).toBeNull();
			const store = await runtime.runPromise(CloudWorkspaceStore);
			await runtime.runPromise(
				store.saveGithubUser({
					accountId: "account",
					login: "octocat",
					name: "Octo",
					email: "private",
					sealedCredentials: await runtime.runPromise(
						sealApiString(
							"github-user\naccount",
							JSON.stringify({ accessToken: "old", expiresAtMs: 0 }),
						),
					),
				}),
			);
			await expect(
				runtime.runPromise(
					githubUserCredential("account", "github.com/acme/repo"),
				),
			).rejects.toMatchObject({ code: "github_user_reconnect_required" });
			await runtime.runPromise(disconnectGithubUser("account"));
			expect(
				await runtime.runPromise(githubUserIdentity("account")),
			).toBeUndefined();
		} finally {
			await runtime.dispose();
		}
	});
	test("disconnect revokes the authorization and scoped tokens before deleting encrypted credentials", async () => {
		const runtime = runtimeForTest();
		const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const store = await runtime.runPromise(CloudWorkspaceStore);
			await runtime.runPromise(
				store.saveGithubUser({
					accountId: "account",
					login: "octocat",
					name: "Octo",
					email: "private",
					sealedCredentials: await runtime.runPromise(
						sealApiString(
							"github-user\naccount",
							JSON.stringify({
								accessToken: "ghu_live",
								expiresAtMs: Date.now() + 60000,
							}),
						),
					),
				}),
			);
			await expect(
				runtime.runPromise(disconnectGithubUser("account")),
			).rejects.toMatchObject({ code: "github_user_disconnect_failed" });
			expect(
				await runtime.runPromise(githubUserIdentity("account")),
			).toBeDefined();
			fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
			await runtime.runPromise(disconnectGithubUser("account"));
			expect(fetchMock).toHaveBeenLastCalledWith(
				"https://api.github.com/applications/client/grant",
				expect.objectContaining({
					method: "DELETE",
					body: JSON.stringify({ access_token: "ghu_live" }),
				}),
			);
			expect(
				await runtime.runPromise(githubUserIdentity("account")),
			).toBeUndefined();
		} finally {
			await runtime.dispose();
		}
	});
	test("disconnect refreshes expired access and preserves the rotation when revocation must retry", async () => {
		const runtime = runtimeForTest();
		let refreshes = 0;
		let revokeStatus = 503;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				if (url.includes("access_token")) {
					refreshes++;
					return Response.json(tokenResponse);
				}
				expect(url).toBe("https://api.github.com/applications/client/grant");
				expect(JSON.parse(String(init.body))).toEqual({
					access_token: "ghu_new",
				});
				return new Response(null, { status: revokeStatus });
			}),
		);
		try {
			const store = await runtime.runPromise(CloudWorkspaceStore);
			await runtime.runPromise(
				store.saveGithubUser({
					accountId: "account",
					login: "octocat",
					name: "Octo",
					email: "private",
					sealedCredentials: await runtime.runPromise(
						sealApiString(
							"github-user\naccount",
							JSON.stringify({
								accessToken: "expired",
								expiresAtMs: 0,
								refreshToken: "refresh",
								refreshExpiresAtMs: Date.now() + 60000,
							}),
						),
					),
				}),
			);
			await expect(
				runtime.runPromise(disconnectGithubUser("account")),
			).rejects.toMatchObject({ code: "github_user_disconnect_failed" });
			const stored = await runtime.runPromise(store.getGithubUser("account"));
			expect(
				JSON.parse(
					await runtime.runPromise(
						openApiString(
							"github-user\naccount",
							stored?.sealedCredentials ?? "",
						),
					),
				).refreshToken,
			).toBe("ghr_new");
			revokeStatus = 204;
			await runtime.runPromise(disconnectGithubUser("account"));
			expect(refreshes).toBe(1);
			expect(
				await runtime.runPromise(store.getGithubUser("account")),
			).toBeNull();
		} finally {
			await runtime.dispose();
		}
	});

	test("concurrent installation disconnects revoke authorization when the final link is removed", async () => {
		const runtime = runtimeForTest();
		const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const store = await runtime.runPromise(CloudWorkspaceStore);
			await runtime.runPromise(
				store.saveGithubUser({
					accountId: "account",
					login: "octocat",
					name: "Octo",
					email: "private",
					sealedCredentials: await runtime.runPromise(
						sealApiString(
							"github-user\naccount",
							JSON.stringify({
								accessToken: "ghu_live",
								expiresAtMs: Date.now() + 60000,
							}),
						),
					),
				}),
			);
			for (const installationId of [99, 100])
				await runtime.runPromise(
					store.saveGithubInstallation({
						accountId: "account",
						installationId,
						githubAccountId: installationId,
						accountLogin: `org${installationId}`,
						accountType: "Organization",
						repositorySelection: "selected",
						suspended: false,
						createdAtMs: 0,
						updatedAtMs: 0,
					}),
				);
			await Promise.all(
				[99, 100].map((id) =>
					runtime.runPromise(disconnectGithubInstallation("account", id)),
				),
			);
			expect(
				await runtime.runPromise(store.listGithubInstallations("account")),
			).toEqual([]);
			expect(
				await runtime.runPromise(store.getGithubUser("account")),
			).toBeNull();
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			await runtime.dispose();
		}
	});
});
