import { Layer, ManagedRuntime, Redacted } from "effect";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { CloudWorkspaceStoreMemory } from "../../src/cloud-workspace-store.ts";
import { layer } from "../../src/config.ts";
import { canDiscoverEnvironment } from "../../src/environment-access.ts";
import type { EnvironmentRecord } from "../../src/store.ts";
import { ApiStoreMemory } from "../../src/store.ts";

const environment: EnvironmentRecord = {
	environmentId: "host",
	accountId: "alice",
	providerKind: "ssh",
	environmentPublicKey: "key",
	httpBaseUrl: "https://host.test",
	wsBaseUrl: "wss://host.test",
	linkedAtMs: 0,
	lastSeenAtMs: 1000,
	sharingAudience: [
		{
			organizationId: "org",
			membershipId: "bob-member",
			subject: "bob",
			adminOnly: false,
		},
	],
};
const runtime = ManagedRuntime.make(
	Layer.mergeAll(
		CloudWorkspaceStoreMemory,
		ApiStoreMemory,
		layer({
			organizationWorkspacesEnabled: true,
			apiIssuer: "https://api.test",
			workosIssuer: "https://auth.test",
			workosJwksUrl: "https://auth.test/jwks",
			mintPrivateKey: Redacted.make("unused"),
			mintPublicKey: "unused",
			workosApiKey: Redacted.make("test-key"),
		}),
	),
);
let role = "member";
let membershipId = "bob-member";
let removed = "";
beforeEach(() => {
	role = "member";
	membershipId = "bob-member";
	removed = "";
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = new URL(String(input));
		const subject = url.searchParams.get("user_id");
		return Response.json({
			data:
				subject === removed
					? []
					: [
							{
								id: subject === "bob" ? membershipId : "alice-member",
								user_id: subject,
								organization_id: "org",
								status: "active",
								role: { slug: subject === "bob" ? role : "admin" },
							},
						],
			list_metadata: { after: null },
		});
	});
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => runtime.dispose());

const canDiscover = (subject = "bob", record = environment, now = 1001) =>
	runtime.runPromise(canDiscoverEnvironment(record, subject, now, 75_000));

it("preserves owner access without consulting WorkOS or requiring a heartbeat", async () => {
	await expect(
		canDiscover("alice", { ...environment, lastSeenAtMs: undefined }),
	).resolves.toBe(true);
	expect(fetch).not.toHaveBeenCalled();
});

it("requires a published grant and a fresh heartbeat", async () => {
	await expect(canDiscover("stranger")).resolves.toBe(false);
	await expect(
		canDiscover("bob", { ...environment, sharingAudience: [] }),
	).resolves.toBe(false);
	await expect(canDiscover("bob", environment, 76_001)).resolves.toBe(false);
	expect(fetch).not.toHaveBeenCalled();
	await expect(canDiscover()).resolves.toBe(true);
});

it.each([
	"alice",
	"bob",
])("denies discovery when %s leaves the organization", async (subject) => {
	removed = subject;
	await expect(canDiscover()).resolves.toBe(false);
});

it("does not resurrect an old grant when someone rejoins", async () => {
	membershipId = "replacement-membership";
	await expect(canDiscover()).resolves.toBe(false);
});

it("requires the live administrator role for implicit organization-owner access", async () => {
	const record = {
		...environment,
		sharingAudience: environment.sharingAudience?.map((entry) => ({
			...entry,
			adminOnly: true,
		})),
	};
	await expect(canDiscover("bob", record)).resolves.toBe(false);
	role = "admin";
	await expect(canDiscover("bob", record)).resolves.toBe(true);
});

it("fails closed on provider outage rather than using the projection as authority", async () => {
	vi.mocked(fetch).mockResolvedValue(Response.json({}, { status: 503 }));
	await expect(canDiscover()).rejects.toMatchObject({
		code: "organizations_unavailable",
		status: 503,
	});
});
