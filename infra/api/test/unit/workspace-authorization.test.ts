import {
	ApiPaths,
	CLOUD_WORKSPACE_OFFER_ID,
	WORKSPACE_SCOPE_HEADER,
} from "@zuse/contracts";
import { SandboxProvidersFake } from "@zuse/sandbox-providers/testing";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireWorkos } from "../../src/auth.ts";
import { routeCloudBillingRequest } from "../../src/cloud-billing-routes.ts";
import { CloudBillingStoreMemory } from "../../src/cloud-billing-store-memory.ts";
import {
	cloudWorkspaceActorPermission,
	requireCloudWorkspaceAccess,
} from "../../src/cloud-workspace-access.ts";
import { CloudWorkspaceStoreMemory } from "../../src/cloud-workspace-store.ts";
import { layer as configurationLayer } from "../../src/config.ts";
import { MachineStore, MachineStoreMemory } from "../../src/machine-store.ts";
import { requireOrganizationMember } from "../../src/organizations.ts";
import { ApiStoreMemory } from "../../src/store.ts";
import { WorkosVerifierTest } from "../../src/workos.ts";
import { requireWorkspaceAccess } from "../../src/workspace-authorization.ts";

const makeRuntime = (organizationWorkspacesEnabled = true) =>
	ManagedRuntime.make(
		Layer.mergeAll(
			ApiStoreMemory,
			MachineStoreMemory,
			CloudBillingStoreMemory,
			CloudWorkspaceStoreMemory,
			SandboxProvidersFake,
			WorkosVerifierTest,
			configurationLayer({
				apiIssuer: "https://api.test",
				workosIssuer: "https://auth.test",
				workosJwksUrl: "https://auth.test/jwks",
				mintPrivateKey: Redacted.make("unused"),
				mintPublicKey: "unused",
				workosApiKey: Redacted.make("unused"),
				organizationWorkspacesEnabled,
			}),
		),
	);

const request = (scope?: string) =>
	new Request("https://api.test/v1/cloud/billing/summary", {
		headers: {
			authorization: "Bearer test-token:user_alice:org_from_token",
			...(scope === undefined ? {} : { [WORKSPACE_SCOPE_HEADER]: scope }),
		},
	});

describe("workspace authorization", () => {
	let runtime: ReturnType<typeof makeRuntime>;
	let role: string;
	let status: string;
	let organizationId: string;
	let userId: string;
	const provider = vi.fn();
	beforeEach(() => {
		runtime = makeRuntime();
		role = "admin";
		status = "active";
		organizationId = "org_a";
		userId = "user_alice";
		provider.mockReset().mockImplementation(async () =>
			Response.json({
				data: [
					{
						id: "membership_a",
						user_id: userId,
						organization_id: organizationId,
						status,
						role: { slug: role },
					},
				],
				list_metadata: { after: null },
			}),
		);
		vi.stubGlobal("fetch", provider);
	});
	afterEach(async () => {
		await runtime.dispose();
		vi.unstubAllGlobals();
	});

	it("rejects a queued author's previous membership even after rejoining as admin", async () => {
		const workspace = {
			accountId: "organization:org_a",
			requestConfig: {
				sharingPolicy: {
					audience: "organization",
					permission: "edit",
					creatorSubject: "user_alice",
					creatorMembershipId: "membership_a",
					grants: [],
				},
			},
		};
		await expect(
			runtime.runPromise(
				cloudWorkspaceActorPermission(workspace, "user_alice", "membership_a"),
			),
		).resolves.toMatchObject({
			permission: "edit",
			actor: { subject: "user_alice", membershipId: "membership_a" },
		});
		await expect(
			runtime.runPromise(
				cloudWorkspaceActorPermission(
					workspace,
					"user_alice",
					"membership_before_rejoin",
				),
			),
		).rejects.toMatchObject({ status: 403 });
	});

	it.each([
		undefined,
		"personal",
	])("preserves Personal identity for scope %s regardless of the token's org claim", async (scope) => {
		const workspace = await runtime.runPromise(
			requireWorkspaceAccess(request(scope), "billing"),
		);
		expect(workspace).toMatchObject({
			ownerId: "user_alice",
			actor: { accountId: "user_alice" },
			scope: { kind: "personal" },
		});
		expect(provider).not.toHaveBeenCalled();
	});

	it.each([
		"",
		"org_a",
		"organization:",
		"organization:../org_a",
		"personal, organization:org_a",
		"organization:org_a:extra",
	])("rejects malformed explicit scope %s instead of falling back", async (scope) => {
		await expect(
			runtime.runPromise(requireWorkspaceAccess(request(scope), "billing")),
		).rejects.toMatchObject({ code: "invalid_workspace_scope" });
		expect(provider).not.toHaveBeenCalled();
	});

	it("keeps the actor separate from the organization owner", async () => {
		const workspace = await runtime.runPromise(
			requireWorkspaceAccess(request("organization:org_a"), "billing"),
		);
		expect(workspace).toMatchObject({
			ownerId: "organization:org_a",
			actor: { accountId: "user_alice" },
			scope: { kind: "organization", organizationId: "org_a" },
		});
		expect(provider.mock.calls[0]?.[0]).toContain(
			"user_id=user_alice&organization_id=org_a",
		);
	});

	it.each([
		["admin", "private", "view", [], "edit", true],
		["member", "organization", "view", [], "view", false],
		["member", "organization", "edit", [], "edit", false],
		[
			"member",
			"private",
			"edit",
			[{ membershipId: "membership_a", permission: "view" }],
			"view",
			false,
		],
		[
			"member",
			"organization",
			"view",
			[{ membershipId: "membership_a", permission: "edit" }],
			"edit",
			false,
		],
	])("resolves %s access to %s chats with %s default", async (memberRole, audience, permission, grants, expectedPermission, canManageSharing) => {
		role = memberRole;
		const workspace = {
			accountId: "organization:org_a",
			requestConfig: {
				sharingPolicy: {
					creatorSubject: "user_creator",
					creatorMembershipId: "membership_creator",
					audience,
					permission,
					grants,
				},
			},
		};
		await expect(
			runtime.runPromise(
				requireCloudWorkspaceAccess(
					request("organization:org_a"),
					workspace,
					"view",
				),
			),
		).resolves.toMatchObject({
			permission: expectedPermission,
			canManageSharing,
		});
		if (expectedPermission === "view")
			await expect(
				runtime.runPromise(
					requireCloudWorkspaceAccess(
						request("organization:org_a"),
						workspace,
						"edit",
					),
				),
			).rejects.toMatchObject({ code: "workspace_access_denied" });
		if (!canManageSharing)
			await expect(
				runtime.runPromise(
					requireCloudWorkspaceAccess(
						request("organization:org_a"),
						workspace,
						"sharing",
					),
				),
			).rejects.toMatchObject({ code: "workspace_access_denied" });
	});

	it("requires the creator's original active membership and denies finance access", async () => {
		role = "member";
		const policy = {
			creatorSubject: "user_alice",
			creatorMembershipId: "membership_a",
			audience: "private",
			permission: "edit",
			grants: [],
		};
		const workspace = {
			accountId: "organization:org_a",
			requestConfig: { sharingPolicy: policy },
		};
		const authorize = () =>
			runtime.runPromise(
				requireCloudWorkspaceAccess(
					request("organization:org_a"),
					workspace,
					"sharing",
				),
			);
		await expect(authorize()).resolves.toMatchObject({
			permission: "edit",
			canManageSharing: true,
		});
		policy.creatorMembershipId = "membership_previous";
		await expect(authorize()).rejects.toMatchObject({
			code: "workspace_access_denied",
		});
		policy.creatorMembershipId = "membership_a";
		status = "inactive";
		await expect(authorize()).rejects.toMatchObject({
			code: "organization_access_denied",
		});
		status = "active";
		role = "billing";
		await expect(authorize()).rejects.toMatchObject({
			code: "workspace_access_denied",
		});
	});

	it("fails closed for missing policies and cross-owner IDs without changing legacy Personal access", async () => {
		role = "member";
		await expect(
			runtime.runPromise(
				requireCloudWorkspaceAccess(
					request("organization:org_a"),
					{ accountId: "organization:org_a", requestConfig: {} },
					"view",
				),
			),
		).rejects.toMatchObject({ code: "workspace_sharing_policy_invalid" });
		await expect(
			runtime.runPromise(
				requireCloudWorkspaceAccess(
					request("organization:org_a"),
					{ accountId: "user_alice", requestConfig: {} },
					"view",
				),
			),
		).rejects.toMatchObject({ code: "workspace_access_denied" });
		await expect(
			runtime.runPromise(
				requireCloudWorkspaceAccess(
					request("personal"),
					{ accountId: "user_alice", requestConfig: {} },
					"edit",
				),
			),
		).resolves.toMatchObject({ permission: "edit", canManageSharing: true });
	});

	it.each([
		undefined,
		{ audience: "invalid" },
	])("allows admins to recover chats with invalid policy %j", async (sharingPolicy) => {
		await expect(
			runtime.runPromise(
				requireCloudWorkspaceAccess(
					request("organization:org_a"),
					{ accountId: "organization:org_a", requestConfig: { sharingPolicy } },
					"edit",
				),
			),
		).resolves.toMatchObject({ permission: "edit", canManageSharing: true });
	});

	it("isolates billing periods and caps, and never uses a member's Personal subscription for an unfunded organization", async () => {
		const now = Date.now();
		await runtime.runPromise(
			Effect.gen(function* () {
				const store = yield* MachineStore;
				for (const ownerId of ["user_alice", "organization:org_a"]) {
					yield* store.upsertEntitlement({
						entitlementId: `entitlement:${ownerId}`,
						accountId: ownerId,
						kind: "cloud-workspace",
						offerId: CLOUD_WORKSPACE_OFFER_ID,
						provider: "manual",
						providerSubscriptionId: `subscription:${ownerId}`,
						status: "active",
						periodStartMs: now - 1_000,
						paidThroughMs: now + 86_400_000,
						createdAtMs: now,
						updatedAtMs: now,
					});
				}
			}),
		);
		const cap = (scope: string, overageCapMicros: number) =>
			runtime.runPromise(
				routeCloudBillingRequest(
					new Request(`https://api.test${ApiPaths.cloudBillingCap}`, {
						method: "POST",
						headers: {
							authorization: "Bearer test-token:user_alice",
							[WORKSPACE_SCOPE_HEADER]: scope,
							"content-type": "application/json",
						},
						body: JSON.stringify({
							overageCapMicros,
							idempotencyKey: "same-operation",
						}),
					}),
				),
			);
		expect(await (await cap("personal", 1_000_000))?.json()).toMatchObject({
			overageCapMicros: 1_000_000,
		});
		expect(
			await (await cap("organization:org_a", 2_000_000))?.json(),
		).toMatchObject({ overageCapMicros: 2_000_000 });
		expect(
			await (
				await runtime.runPromise(routeCloudBillingRequest(request("personal")))
			)?.json(),
		).toMatchObject({
			overageCapMicros: 1_000_000,
			periodStart: now - 1_000,
			periodEnd: now + 86_400_000,
		});
		organizationId = "org_b";
		await expect(
			runtime.runPromise(
				routeCloudBillingRequest(request("organization:org_b")),
			),
		).rejects.toMatchObject({ code: "cloud_billing_subscription_required" });
	});

	it.each([
		["admin", "content", true],
		["admin", "administration", true],
		["admin", "billing", true],
		["member", "content", true],
		["member", "administration", false],
		["member", "billing", false],
		["billing", "content", false],
		["billing", "administration", false],
		["billing", "billing", true],
		["unknown", "content", false],
		["unknown", "billing", false],
	] as const)("%s / %s permission", async (memberRole, access, allowed) => {
		role = memberRole;
		const result = runtime.runPromise(
			requireWorkspaceAccess(request("organization:org_a"), access),
		);
		if (allowed)
			await expect(result).resolves.toMatchObject({
				ownerId: "organization:org_a",
			});
		else
			await expect(result).rejects.toMatchObject({
				code: "workspace_access_denied",
			});
	});

	it("does not authorize another organization's membership", async () => {
		organizationId = "org_b";
		await expect(
			runtime.runPromise(
				requireWorkspaceAccess(request("organization:org_a"), "billing"),
			),
		).rejects.toMatchObject({ code: "organization_access_denied" });
	});

	it("does not authorize another user's membership", async () => {
		userId = "user_bob";
		await expect(
			runtime.runPromise(
				requireWorkspaceAccess(request("organization:org_a"), "billing"),
			),
		).rejects.toMatchObject({ code: "organization_access_denied" });
	});

	it("rechecks membership on the next request after removal", async () => {
		await runtime.runPromise(
			requireWorkspaceAccess(request("organization:org_a"), "billing"),
		);
		status = "inactive";
		await expect(
			runtime.runPromise(
				requireWorkspaceAccess(request("organization:org_a"), "billing"),
			),
		).rejects.toMatchObject({ code: "organization_access_denied" });
	});

	it("fails closed during WorkOS outage", async () => {
		provider.mockRejectedValue(new Error("offline"));
		await expect(
			runtime.runPromise(
				requireWorkspaceAccess(request("organization:org_a"), "billing"),
			),
		).rejects.toMatchObject({ code: "organizations_unavailable" });
	});

	it("keeps organization access behind the rollout gate", async () => {
		const disabled = makeRuntime(false);
		try {
			await expect(
				disabled.runPromise(
					requireWorkspaceAccess(request("organization:org_a"), "billing"),
				),
			).rejects.toMatchObject({ code: "organization_workspaces_disabled" });
			expect(provider).not.toHaveBeenCalled();
		} finally {
			await disabled.dispose();
		}
	});

	it("rejects organization scope on legacy account-owned routes", async () => {
		await expect(
			runtime.runPromise(requireWorkos(request("organization:org_a"))),
		).rejects.toMatchObject({ code: "workspace_scope_not_supported" });
	});

	it.each([
		"billing",
		"unknown",
	])("does not let %s roles use existing collaboration membership authorization", async (memberRole) => {
		role = memberRole;
		await expect(
			runtime.runPromise(requireOrganizationMember("user_alice", "org_a")),
		).rejects.toMatchObject({ code: "organization_access_denied" });
	});
});
