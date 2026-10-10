import { generateKeyPairSync } from "node:crypto";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { afterEach, expect, test, vi } from "vitest";
import {
	githubAuthorizationCallback,
	githubAuthorizationUrl,
	githubInstallationCredentialForRepository,
	githubInstallationGrants,
	makeGithubInstallUrl,
} from "../../src/cloud-github-app.ts";
import {
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import { layer } from "../../src/config.ts";
import { ApiStoreMemory } from "../../src/store.ts";

const origin = "https://api-staging.zuse.sh";
const installation = {
	id: 123,
	app_id: 1,
	account: { id: 99, login: "acme", type: "Organization" },
	repository_selection: "all",
	suspended_at: null,
};
const keys = generateKeyPairSync("ed25519");
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const makeRuntime = () =>
	ManagedRuntime.make(
		Layer.mergeAll(
			ApiStoreMemory,
			CloudWorkspaceStoreMemory,
			layer({
				apiIssuer: origin,
				workosIssuer: "unused",
				workosJwksUrl: "unused",
				workosApiKey: Redacted.make("workos"),
				organizationWorkspacesEnabled: true,
				mintPrivateKey: Redacted.make(
					JSON.stringify(keys.privateKey.export({ format: "jwk" })),
				),
				mintPublicKey: JSON.stringify(keys.publicKey.export({ format: "jwk" })),
				cloudDataEncryptionKey: Redacted.make(
					Buffer.alloc(32, 7).toString("base64url"),
				),
				githubApp: {
					appId: "1",
					slug: "zuse",
					clientId: "client",
					clientSecret: Redacted.make("secret"),
					privateKey: Redacted.make(
						rsa.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
					),
				},
			}),
		),
	);
afterEach(() => vi.unstubAllGlobals());

test.each([
	false,
	true,
])("a GitHub member connects an %s-existing installation after owner approval without a founder Zuse account", async (alreadyInstalled) => {
	const runtime = makeRuntime();
	let approved = alreadyInstalled;
	let active = true;
	let writable = true;
	let zuseAdmin = true;
	const tokenBodies: unknown[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/user_management/organization_memberships?"))
				return Response.json({
					data: [
						{
							id: "member",
							organization_id: "team",
							user_id: "requester",
							status: "active",
							role: { slug: zuseAdmin ? "admin" : "member" },
						},
					],
					list_metadata: { after: null },
				});
			if (url.endsWith("/organizations/team"))
				return Response.json({ id: "team", name: "Our team" });
			if (url.includes("/login/oauth/access_token"))
				return Response.json({
					access_token: "requester-token",
					expires_in: 8 * 60 * 60,
				});
			if (url.endsWith("/user"))
				return Response.json({ id: 7, login: "requester", name: "Requester" });
			if (url.includes("/user/installations?"))
				return Response.json({ installations: approved ? [installation] : [] });
			if (url.includes("/user/memberships/orgs/acme"))
				return Response.json({
					role: "member",
					state: active ? "active" : "pending",
				});
			if (url.includes("/user/installations/123/repositories?"))
				return Response.json({
					repositories: [
						{ full_name: "acme/writable", permissions: { push: writable } },
						{ full_name: "acme/readonly", permissions: { push: false } },
						{ full_name: "other/writable", permissions: { push: true } },
					],
				});
			if (url.endsWith("/app/installations/123"))
				return Response.json(installation);
			if (url.endsWith("/app/installations/123/access_tokens")) {
				tokenBodies.push(JSON.parse(String(init?.body)));
				return Response.json({
					token: "scoped-installation",
					expires_at: "2099-01-01T00:00:00Z",
				});
			}
			if (url.includes("/installation/repositories?"))
				return Response.json({
					repositories: [
						{
							full_name: "acme/writable",
							clone_url: "https://github.com/acme/writable.git",
							default_branch: "main",
							private: true,
							description: null,
							owner: {},
							updated_at: "2026-10-10T00:00:00Z",
						},
					],
				});
			throw new Error(`Unexpected endpoint ${new URL(url).pathname}`);
		}),
	);
	try {
		const install = await runtime.runPromise(
			makeGithubInstallUrl("organization:team", "requester"),
		);
		const start = await runtime.runPromise(
			githubAuthorizationCallback(
				new Request(githubAuthorizationUrl(install, origin)),
			),
		);
		let cookie = start.headers.get("set-cookie")?.split(";")[0] ?? "";
		const oauth = new URL(start.headers.get("location") ?? "");
		const callback = new URL(oauth.searchParams.get("redirect_uri") ?? "");
		callback.searchParams.set("state", oauth.searchParams.get("state") ?? "");
		callback.searchParams.set("code", "oauth-code");
		let chooser = await runtime.runPromise(
			githubAuthorizationCallback(
				new Request(callback, { headers: { cookie } }),
			),
		);
		if (!approved) {
			expect(chooser.status).toBe(302);
			const requestUrl = new URL(`${origin}/v1/cloud/github/callback`);
			requestUrl.searchParams.set(
				"state",
				new URL(chooser.headers.get("location") ?? "").searchParams.get(
					"state",
				) ?? "",
			);
			requestUrl.searchParams.set("setup_action", "request");
			const pending = await runtime.runPromise(
				githubAuthorizationCallback(
					new Request(requestUrl, { headers: { cookie } }),
				),
			);
			const html = await pending.text();
			expect(html).toContain("Check approval");
			expect(html).toContain("Your owner only needs GitHub");
			expect(html).toContain("data-approval-check");
			expect(html).not.toContain("requester-token");
			const pendingState = requestUrl.searchParams.get("state") ?? "";
			const poll = (headers = { cookie, origin }) =>
				new Request(`${origin}/v1/cloud/github/callback`, {
					method: "POST",
					headers,
					body: new URLSearchParams({
						csrf: pendingState,
						action: "check-approval",
					}),
				});
			expect(
				await (
					await runtime.runPromise(githubAuthorizationCallback(poll()))
				).json(),
			).toEqual({ ready: false });
			expect(
				await runtime.runPromise(
					githubAuthorizationCallback(
						poll({ cookie, origin: "https://attacker.example" }),
					).pipe(Effect.result),
				),
			).toMatchObject({ failure: { code: "invalid_github_install_state" } });
			expect(
				await runtime.runPromise(
					githubAuthorizationCallback(poll({ cookie: "", origin })).pipe(
						Effect.result,
					),
				),
			).toMatchObject({ failure: { code: "invalid_github_browser_state" } });
			const resume =
				/href="([^"]+)">Check approval/
					.exec(html)?.[1]
					?.replaceAll("&amp;", "&") ?? "";
			vi.useFakeTimers({ toFake: ["Date"] });
			try {
				vi.setSystemTime(Date.now() + 9 * 60 * 60_000);
				const expired = await runtime.runPromise(
					githubAuthorizationCallback(poll()),
				);
				expect(expired.status).toBe(200);
				expect(await expired.json()).toEqual({
					ready: false,
					reauthorize: true,
				});
				const renew = await runtime.runPromise(
					githubAuthorizationCallback(new Request(resume)),
				);
				expect(renew.status).toBe(302);
				expect(renew.headers.get("location")).toContain(
					"https://github.com/login/oauth/authorize",
				);
			} finally {
				vi.useRealTimers();
			}
			approved = true;
			expect(
				await (
					await runtime.runPromise(githubAuthorizationCallback(poll()))
				).json(),
			).toEqual({ ready: true });
			const store = await runtime.runPromise(CloudWorkspaceStore);
			expect(
				await runtime.runPromise(
					store.listGithubInstallations("organization:team"),
				),
			).toEqual([]);
			const restart = await runtime.runPromise(
				githubAuthorizationCallback(new Request(resume)),
			);
			cookie = restart.headers.get("set-cookie")?.split(";")[0] ?? "";
			const authorize = new URL(restart.headers.get("location") ?? "");
			callback.searchParams.set(
				"state",
				authorize.searchParams.get("state") ?? "",
			);
			chooser = await runtime.runPromise(
				githubAuthorizationCallback(
					new Request(callback, { headers: { cookie } }),
				),
			);
		}
		const html = await chooser.text();
		expect(html).toContain("Use this account: acme");
		expect(html).toContain("Our team");
		expect(html).not.toContain("requester-token");
		const checkApproval =
			[...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)]
				.find((match) => match[2]?.includes("Check approval"))?.[1]
				?.replaceAll("&amp;", "&") ?? "";
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(Date.now() + 20 * 60_000);
			const delayedCheck = await runtime.runPromise(
				githubAuthorizationCallback(new Request(checkApproval)),
			);
			expect(delayedCheck.status).toBe(302);
			expect(delayedCheck.headers.get("location")).toContain(
				"https://github.com/login/oauth/authorize",
			);
		} finally {
			vi.useRealTimers();
		}
		if (alreadyInstalled) {
			const another =
				[...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)].find(
					(match) => match[2]?.includes("Add another GitHub account"),
				)?.[1] ?? "";
			const pendingState = new URL(another).searchParams.get("state") ?? "";
			const poll = new Request(`${origin}/v1/cloud/github/callback`, {
				method: "POST",
				headers: { cookie, origin },
				body: new URLSearchParams({
					csrf: pendingState,
					action: "check-approval",
				}),
			});
			// An unrelated installation already available before requesting must
			// not make a new owner-approval request appear complete.
			expect(
				await (
					await runtime.runPromise(githubAuthorizationCallback(poll))
				).json(),
			).toEqual({ ready: false });
		}
		const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
		const select = () =>
			new Request(`${origin}/v1/cloud/github/callback`, {
				method: "POST",
				headers: { cookie, origin },
				body: new URLSearchParams({ csrf }),
			});
		const store = await runtime.runPromise(CloudWorkspaceStore);
		active = false;
		expect(
			await runtime.runPromise(
				githubAuthorizationCallback(select()).pipe(Effect.result),
			),
		).toMatchObject({
			failure: { code: "github_organization_installation_required" },
		});
		active = true;
		writable = false;
		expect(
			await runtime.runPromise(
				githubAuthorizationCallback(select()).pipe(Effect.result),
			),
		).toMatchObject({
			failure: { code: "github_organization_installation_required" },
		});
		writable = true;
		zuseAdmin = false;
		expect(
			await runtime.runPromise(
				githubAuthorizationCallback(select()).pipe(Effect.result),
			),
		).toMatchObject({
			failure: { code: "github_organization_installation_required" },
		});
		zuseAdmin = true;
		expect(
			await runtime.runPromise(
				store.listGithubInstallations("organization:team"),
			),
		).toEqual([]);
		const connected = await runtime.runPromise(
			githubAuthorizationCallback(select()),
		);
		expect(await connected.text()).toContain("acme is connected");
		expect(
			await runtime.runPromise(
				store.listGithubInstallations("organization:team"),
			),
		).toMatchObject([{ allowedRepositories: ["acme/writable"] }]);
		expect(
			await runtime.runPromise(store.getGithubUser("requester")),
		).toMatchObject({ login: "requester" });
		expect(await runtime.runPromise(store.getGithubUser("founder"))).toBeNull();
		await runtime.runPromise(githubInstallationGrants("organization:team"));
		expect(tokenBodies).toEqual([
			{ repositories: ["writable"], permissions: { contents: "read" } },
		]);
		expect(
			await runtime.runPromise(
				githubInstallationCredentialForRepository(
					"organization:team",
					"github.com/acme/readonly",
				),
			),
		).toBeNull();
		expect(tokenBodies).toHaveLength(1);
		await runtime.runPromise(
			store.refreshGithubInstallation(
				123,
				{
					githubAccountId: 99,
					accountLogin: "acme",
					accountType: "Organization",
					repositorySelection: "all",
					suspended: false,
				},
				Date.now() + 1000,
			),
		);
		expect(
			await runtime.runPromise(
				store.listGithubInstallations("organization:team"),
			),
		).toMatchObject([{ allowedRepositories: ["acme/writable"] }]);
	} finally {
		await runtime.dispose();
	}
});

test.each([
	{ status: 200, state: "active", push: false, expected: "denied" },
	{ status: 200, state: "pending", push: true, expected: "denied" },
	{ status: 403, state: "active", push: true, expected: "approval-required" },
	{ status: 404, state: "active", push: true, expected: "denied" },
])("does not grant member access for membership status $status, state $state and push $push", async ({
	status,
	state,
	push,
	expected,
}) => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) =>
			String(input).includes("/memberships/")
				? Response.json({ role: "member", state }, { status })
				: Response.json({
						repositories: [{ full_name: "acme/repo", permissions: { push } }],
					}),
		),
	);
	const { githubLinkAccess } = await import("../../src/github-link-access.ts");
	expect(
		await Effect.runPromise(githubLinkAccess(installation, 7, "user-token")),
	).toEqual({ kind: expected });
});

test("GitHub outages fail the approval check instead of appearing as a missing grant", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({}, { status: 500 })),
	);
	const { githubLinkAccess } = await import("../../src/github-link-access.ts");
	expect(
		await Effect.runPromise(
			githubLinkAccess(installation, 7, "user-token").pipe(Effect.result),
		),
	).toMatchObject({
		failure: { code: "github_app_unavailable", detail: "github_500" },
	});
});
