import { createHmac, generateKeyPairSync } from "node:crypto";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	githubWebhook,
	refreshGithubConnections,
} from "../../src/cloud-github-app.ts";
import {
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import { layer as configurationLayer } from "../../src/config.ts";
import { ApiStore, ApiStoreMemory } from "../../src/store.ts";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
	.privateKey.export({ format: "pem", type: "pkcs8" })
	.toString();
const makeRuntime = (secret: string | undefined = "webhook-secret") =>
	ManagedRuntime.make(
		Layer.mergeAll(
			ApiStoreMemory,
			CloudWorkspaceStoreMemory,
			configurationLayer({
				apiIssuer: "https://api-staging.zuse.sh",
				workosJwksUrl: "unused",
				workosIssuer: "unused",
				mintPrivateKey: Redacted.make("unused"),
				mintPublicKey: "unused",
				githubApp: {
					appId: "1",
					slug: "zusehq-staging",
					privateKey: Redacted.make(privateKey),
					webhookSecret:
						secret === undefined ? undefined : Redacted.make(secret),
				},
			}),
		),
	);
const record = (accountId: string, installationId = 123) => ({
	accountId,
	installationId,
	githubAccountId: 7,
	accountLogin: "before",
	accountType: "Organization" as const,
	repositorySelection: "selected" as const,
	suspended: false,
	createdAtMs: 1,
	updatedAtMs: 1,
});
const installation = {
	id: 123,
	app_id: 1,
	account: { id: 7, login: "acme", type: "Organization" },
	repository_selection: "all",
	suspended_at: null,
};
const request = (
	event = "installation",
	body = JSON.stringify({ action: "created", installation }),
	secret = "webhook-secret",
) =>
	new Request("https://api-staging.zuse.sh/v1/cloud/github/webhook", {
		method: "POST",
		body,
		headers: {
			"x-github-event": event,
			"x-github-delivery": "same-delivery",
			"x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
		},
	});

afterEach(() => vi.unstubAllGlobals());

describe("GitHub installation webhooks", () => {
	test("organization membership events invalidate durable eligibility without enrolling anyone", async () => {
		const runtime = makeRuntime();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(installation)),
		);
		try {
			const store = await runtime.runPromise(ApiStore);
			await runtime.runPromise(
				store.githubJoining.savePolicy({
					organizationId: "org",
					installationId: 123,
					githubOrgId: 7,
					login: "acme",
					enabled: true,
					revision: "before",
				}),
			);
			const event = () =>
				request(
					"organization",
					JSON.stringify({
						action: "member_removed",
						installation: { id: 123 },
						membership: { user: { id: 10 } },
					}),
				);
			await runtime.runPromise(githubWebhook(event()));
			const first = await runtime.runPromise(
				store.githubJoining.listPolicies(),
			);
			expect(first[0]?.revision).not.toBe("before");
			await runtime.runPromise(githubWebhook(event()));
			const second = await runtime.runPromise(
				store.githubJoining.listPolicies(),
			);
			expect(second[0]?.revision).not.toBe(first[0]?.revision);
			expect(second[0]?.enabled).toBe(true);
			expect(
				await runtime.runPromise(store.githubJoining.listEnrollments()),
			).toEqual([]);
		} finally {
			await runtime.dispose();
		}
	});

	test("bounds chunked bodies without trusting Content-Length", async () => {
		const runtime = makeRuntime();
		let cancelled = false;
		try {
			const oversized = new Request(request(), {
				body: new ReadableStream({
					pull(controller) {
						controller.enqueue(new Uint8Array(1024 * 1024));
					},
					cancel() {
						cancelled = true;
					},
				}),
				duplex: "half",
			} as RequestInit);
			expect(
				(await runtime.runPromise(githubWebhook(oversized).pipe(Effect.flip)))
					.status,
			).toBe(413);
			expect(cancelled).toBe(true);
		} finally {
			await runtime.dispose();
		}
	});
	test("rejects tampered signatures and malformed events before calling GitHub", async () => {
		const runtime = makeRuntime();
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		try {
			for (const invalid of [
				request("installation", "{}", "wrong-secret"),
				new Request(request(), { headers: {} }),
			]) {
				const error = await runtime.runPromise(
					githubWebhook(invalid).pipe(Effect.flip),
				);
				expect(error.status).toBe(401);
			}
			for (const body of [
				"not json",
				"{}",
				JSON.stringify({ installation: { id: 123, app_id: 2 } }),
			]) {
				expect(
					(
						await runtime.runPromise(
							githubWebhook(request("installation", body)).pipe(Effect.flip),
						)
					).status,
				).toBe(400);
			}
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			await runtime.dispose();
		}
	});

	test("fails closed without a secret; accepts signed ping and ignores unrelated events", async () => {
		const runtime = makeRuntime("");
		const configured = makeRuntime();
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		try {
			expect(
				(await runtime.runPromise(githubWebhook(request()).pipe(Effect.flip)))
					.status,
			).toBe(503);
			for (const event of ["ping", "push"])
				expect(
					(await configured.runPromise(githubWebhook(request(event)))).status,
				).toBe(200);
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			await runtime.dispose();
			await configured.dispose();
		}
	});

	test("reconciles all linked workspaces, tolerates duplicates and never auto-enrolls", async () => {
		const runtime = makeRuntime();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					...installation,
					suspended_at: "2026-10-01T00:00:00Z",
				}),
			),
		);
		try {
			const store = await runtime.runPromise(CloudWorkspaceStore);
			for (const owner of ["personal", "organization:one", "organization:two"])
				await runtime.runPromise(store.saveGithubInstallation(record(owner)));
			await runtime.runPromise(
				store.saveGithubInstallation(record("unrelated", 456)),
			);
			for (const event of [
				"installation",
				"installation_repositories",
				"installation",
			]) {
				expect(
					(await runtime.runPromise(githubWebhook(request(event)))).status,
				).toBe(200);
			}
			for (const owner of [
				"personal",
				"organization:one",
				"organization:two",
			]) {
				expect(
					await runtime.runPromise(store.listGithubInstallations(owner)),
				).toMatchObject([
					{
						accountId: owner,
						accountLogin: "acme",
						suspended: true,
						repositorySelection: "all",
						createdAtMs: 1,
					},
				]);
			}
			expect(
				await runtime.runPromise(store.listGithubInstallations("unrelated")),
			).toEqual([record("unrelated", 456)]);
			expect(
				await runtime.runPromise(store.listGithubInstallations("sender")),
			).toEqual([]);
			await runtime.runPromise(store.removeGithubInstallation("personal", 123));
			await runtime.runPromise(githubWebhook(request()));
			expect(
				await runtime.runPromise(store.listGithubInstallations("personal")),
			).toEqual([]);
		} finally {
			await runtime.dispose();
		}
	});

	test("out-of-order deleted payload does not delete a live installation; missed events reconcile on refresh", async () => {
		const runtime = makeRuntime();
		let status = 200;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(installation, { status })),
		);
		try {
			const store = await runtime.runPromise(CloudWorkspaceStore);
			await runtime.runPromise(
				store.saveGithubInstallation(record("personal")),
			);
			await runtime.runPromise(
				githubWebhook(
					request(
						"installation",
						JSON.stringify({ action: "deleted", installation }),
					),
				),
			);
			expect(
				await runtime.runPromise(store.listGithubInstallations("personal")),
			).toHaveLength(1);
			await runtime.runPromise(
				store.saveGithubInstallation({
					...record("personal"),
					suspended: true,
				}),
			);
			expect(
				await runtime.runPromise(refreshGithubConnections("personal")),
			).toMatchObject([{ suspended: false }]);
			await runtime.runPromise(
				store.saveGithubInstallation(record("personal")),
			);
			status = 503;
			expect(
				(await runtime.runPromise(githubWebhook(request()).pipe(Effect.flip)))
					.status,
			).toBe(503);
			expect(
				await runtime.runPromise(store.listGithubInstallations("personal")),
			).toHaveLength(1);
			status = 404;
			await runtime.runPromise(refreshGithubConnections("personal"));
			expect(
				await runtime.runPromise(store.listGithubInstallations("personal")),
			).toEqual([]);
		} finally {
			await runtime.dispose();
		}
	});

	test("stale concurrent refreshes cannot overwrite a newer observation or recreate removed links", async () => {
		const runtime = makeRuntime();
		try {
			const store = await runtime.runPromise(CloudWorkspaceStore);
			const state = record("personal");
			await runtime.runPromise(store.saveGithubInstallation(state));
			await runtime.runPromise(
				store.refreshGithubInstallation(
					123,
					{ ...state, suspended: true },
					300,
				),
			);
			await runtime.runPromise(
				store.refreshGithubInstallation(123, state, 200),
			);
			await runtime.runPromise(store.refreshGithubInstallation(123, null, 200));
			expect(
				await runtime.runPromise(store.listGithubInstallations("personal")),
			).toMatchObject([{ suspended: true, updatedAtMs: 300 }]);
			await runtime.runPromise(store.removeGithubInstallation("personal", 123));
			await runtime.runPromise(
				store.refreshGithubInstallation(123, state, 400),
			);
			expect(
				await runtime.runPromise(store.listGithubInstallations("personal")),
			).toEqual([]);
		} finally {
			await runtime.dispose();
		}
	});
});
