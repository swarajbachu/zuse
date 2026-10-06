import { analyticsAccountId } from "@zuse/analytics/identity";
import { ApiPaths } from "@zuse/contracts";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CloudWorkspaceStoreMemory } from "../../src/cloud-workspace-store.ts";
import {
	type ApiConfig,
	layer as configurationLayer,
} from "../../src/config.ts";
import {
	organizationAccessAllowed,
	organizationCreationAllowed,
} from "../../src/organization-rollout.ts";
import {
	requireOrganizationMembership,
	routeOrganizationRequest,
} from "../../src/organizations.ts";
import { ApiStoreMemory } from "../../src/store.ts";
import { WorkosVerifierTest } from "../../src/workos.ts";

const disposers: Array<() => Promise<void>> = [];
const makeRuntime = (overrides: Partial<ApiConfig> = {}) => {
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			configurationLayer({
				apiIssuer: "https://api.test",
				workosIssuer: "unused",
				workosJwksUrl: "unused",
				mintPrivateKey: Redacted.make("unused"),
				mintPublicKey: "unused",
				workosApiKey: Redacted.make("workos-secret"),
				organizationWorkspacesEnabled: true,
				organizationRolloutEnabled: true,
				organizationPosthog: {
					projectKey: Redacted.make("project-key"),
					host: "https://posthog.test",
				},
				...overrides,
			}),
			ApiStoreMemory,
			CloudWorkspaceStoreMemory,
			WorkosVerifierTest,
		),
	);
	disposers.push(() => runtime.dispose());
	return runtime;
};
const fetchMock = vi.fn<typeof fetch>();
let creation: boolean;
let group: boolean;
let unavailable: boolean;
let members: Array<{
	id: string;
	user_id: string;
	organization_id: string;
	status: string;
	role: { slug: string };
}>;
beforeEach(() => {
	creation = false;
	group = false;
	unavailable = false;
	members = [
		{
			id: "member",
			user_id: "bob",
			organization_id: "org-a",
			status: "active",
			role: { slug: "member" },
		},
	];
	fetchMock.mockReset().mockImplementation(async (input, init) => {
		const url = new URL(String(input));
		if (url.host === "posthog.test") {
			if (unavailable) return new Response("unavailable", { status: 503 });
			const body = JSON.parse(String(init?.body));
			return Response.json({
				flags: {
					"organization-creation": {
						enabled:
							creation && body.distinct_id === analyticsAccountId("alice"),
					},
					"organization-access": {
						enabled: group && body.groups?.organization === "org-a",
					},
				},
				errorsWhileComputingFlags: false,
			});
		}
		if (url.pathname === "/organizations/org-a")
			return Response.json({
				id: "org-a",
				name: "Team A",
				metadata: { zuse_creator: "alice" },
			});
		if (url.pathname === "/user_management/organization_memberships")
			return Response.json({
				list_metadata: { after: null },
				data: members.filter(
					(member) => member.user_id === url.searchParams.get("user_id"),
				),
			});
		throw new Error(`Unexpected request: ${url.pathname}`);
	});
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
	await Promise.all(disposers.splice(0).map((dispose) => dispose()));
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
const request = (path: string, user = "bob", body?: unknown) =>
	new Request(`https://api.test${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			authorization: `Bearer test-token:${user}:org-a`,
			"content-type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

it("uses the existing pseudonymous analytics identity for user targeting", async () => {
	creation = true;
	const runtime = makeRuntime();
	expect(await runtime.runPromise(organizationCreationAllowed("alice"))).toBe(
		true,
	);
	expect(await runtime.runPromise(organizationCreationAllowed("bob"))).toBe(
		false,
	);
	const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
	expect(body).toMatchObject({
		api_key: "project-key",
		distinct_id: analyticsAccountId("alice"),
	});
	expect(JSON.stringify(body)).not.toContain('"alice"');
});
it("automatically enables approved creators' teams for unapproved members", async () => {
	creation = true;
	const runtime = makeRuntime();
	expect(await runtime.runPromise(organizationAccessAllowed("org-a"))).toBe(
		true,
	);
	const response = await runtime.runPromise(
		routeOrganizationRequest(request(ApiPaths.organizationCapabilities)),
	);
	expect(await response?.json()).toMatchObject({
		canCreate: false,
		organizations: [{ id: "org-a", role: "member" }],
	});
});
it("can enable an existing team directly by its group ID", async () => {
	group = true;
	const runtime = makeRuntime();
	expect(await runtime.runPromise(organizationAccessAllowed("org-a"))).toBe(
		true,
	);
	const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
	expect(body).toMatchObject({
		groups: { organization: "org-a" },
		group_properties: { organization: { $group_key: "org-a" } },
	});
	expect(fetchMock).toHaveBeenCalledOnce();
});
it("does not grant membership just because a team is enabled", async () => {
	group = true;
	members = [];
	await expect(
		makeRuntime().runPromise(requireOrganizationMembership("bob", "org-a")),
	).rejects.toMatchObject({ code: "organization_access_denied" });
});
it("hides unapproved teams and denies direct access and creation before mutations", async () => {
	const runtime = makeRuntime();
	const response = await runtime.runPromise(
		routeOrganizationRequest(request(ApiPaths.organizationCapabilities)),
	);
	expect(await response?.json()).toEqual({
		canCreate: false,
		organizations: [],
	});
	await expect(
		runtime.runPromise(requireOrganizationMembership("bob", "org-a")),
	).rejects.toMatchObject({ code: "organization_workspaces_disabled" });
	await expect(
		runtime.runPromise(
			routeOrganizationRequest(
				request(ApiPaths.organizations, "bob", {
					name: "No",
					operationId: crypto.randomUUID(),
				}),
			),
		),
	).rejects.toMatchObject({ code: "organization_creation_disabled" });
	expect(
		fetchMock.mock.calls.filter(
			([input, init]) =>
				new URL(String(input)).host === "api.workos.com" &&
				init?.method !== "GET",
		),
	).toEqual([]);
});
it("keeps the global kill switch above user and team approval", async () => {
	creation = true;
	group = true;
	const runtime = makeRuntime({ organizationWorkspacesEnabled: false });
	expect(await runtime.runPromise(organizationAccessAllowed("org-a"))).toBe(
		false,
	);
	expect(await runtime.runPromise(organizationCreationAllowed("alice"))).toBe(
		false,
	);
	const response = await runtime.runPromise(
		routeOrganizationRequest(request(ApiPaths.organizationCapabilities)),
	);
	expect(await response?.json()).toEqual({
		canCreate: false,
		organizations: [],
	});
	expect(fetchMock).not.toHaveBeenCalled();
});
it("preserves existing deployments when targeted rollout is disabled", async () => {
	const runtime = makeRuntime({ organizationRolloutEnabled: false });
	expect(await runtime.runPromise(organizationCreationAllowed("anyone"))).toBe(
		true,
	);
	expect(await runtime.runPromise(organizationAccessAllowed("any-team"))).toBe(
		true,
	);
	expect(fetchMock).not.toHaveBeenCalled();
});
it("fails closed when targeting is enabled without a project key", async () => {
	const runtime = makeRuntime({ organizationPosthog: undefined });
	expect(await runtime.runPromise(organizationAccessAllowed("org-a"))).toBe(
		false,
	);
	expect(await runtime.runPromise(organizationCreationAllowed("alice"))).toBe(
		false,
	);
	expect(fetchMock).not.toHaveBeenCalled();
});
it("coalesces requests and expires approvals before an outage or flag revocation", async () => {
	vi.useFakeTimers();
	creation = true;
	group = true;
	const runtime = makeRuntime();
	expect(
		await runtime.runPromise(
			Effect.all(
				Array.from({ length: 10 }, () => organizationAccessAllowed("org-a")),
				{ concurrency: "unbounded" },
			),
		),
	).toEqual(Array(10).fill(true));
	expect(fetchMock).toHaveBeenCalledOnce();
	vi.advanceTimersByTime(30_001);
	unavailable = true;
	expect(await runtime.runPromise(organizationAccessAllowed("org-a"))).toBe(
		false,
	);
	vi.advanceTimersByTime(5_001);
	unavailable = false;
	creation = false;
	group = false;
	expect(await runtime.runPromise(organizationAccessAllowed("org-a"))).toBe(
		false,
	);
});
it.each([
	{},
	{ flags: { "organization-creation": { enabled: "true" } } },
	{ flags: { "organization-creation": { enabled: true, variant: "on" } } },
	{
		flags: { "organization-creation": { enabled: true } },
		errorsWhileComputingFlags: true,
	},
])("fails closed for malformed, multivariate or incomplete flag results: %j", async (body) => {
	fetchMock.mockResolvedValue(Response.json(body));
	expect(
		await makeRuntime().runPromise(organizationCreationAllowed("alice")),
	).toBe(false);
});

it("revokes inherited team access when its creator is no longer approved", async () => {
	vi.useFakeTimers();
	creation = true;
	const runtime = makeRuntime();
	expect(await runtime.runPromise(organizationAccessAllowed("org-a"))).toBe(
		true,
	);
	creation = false;
	vi.advanceTimersByTime(30_001);
	expect(await runtime.runPromise(organizationAccessAllowed("org-a"))).toBe(
		false,
	);
});

it("does not infer team approval from the requesting member", async () => {
	creation = true;
	const provider = fetchMock.getMockImplementation();
	fetchMock.mockImplementation(async (input, init) => {
		if (new URL(String(input)).pathname === "/organizations/org-a")
			return Response.json({
				id: "org-a",
				name: "Team A",
				metadata: { zuse_creator: "unapproved-owner" },
			});
		if (!provider) throw new Error("Missing provider fixture");
		return provider(input, init);
	});
	const runtime = makeRuntime();
	expect(await runtime.runPromise(organizationCreationAllowed("alice"))).toBe(
		true,
	);
	expect(await runtime.runPromise(organizationAccessAllowed("org-a"))).toBe(
		false,
	);
});

it("denies a flag request that times out", async () => {
	fetchMock.mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
	expect(
		await makeRuntime().runPromise(organizationCreationAllowed("alice")),
	).toBe(false);
	expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
});
