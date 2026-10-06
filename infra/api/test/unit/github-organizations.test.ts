import { ApiPaths } from "@zuse/contracts";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudWorkspaceActorPermission } from "../../src/cloud-workspace-access.ts";
import {
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import { layer as configurationLayer } from "../../src/config.ts";
import {
	githubMemberEligible,
	invalidateGithubJoining,
	reconcileGithubMemberships,
	refreshGithubRosters,
} from "../../src/github-membership.ts";
import {
	joinGithubOrganization,
	routeGithubOrganizationRequest,
	syncGithubAutoJoin,
} from "../../src/github-organizations.ts";
import {
	requireOrganizationMembership,
	routeOrganizationRequest,
} from "../../src/organizations.ts";
import { ApiStore, ApiStoreMemory } from "../../src/store.ts";
import { WorkosVerifierTest } from "../../src/workos.ts";

const github = vi.hoisted(() => ({
	members: [10, 11, 12],
	suspended: false,
	permission: true,
	unavailable: false,
	reads: 0,
	userId: 10,
}));
vi.mock("../../src/github-transport.ts", async () => {
	const { Effect } = await import("effect");
	const { serviceUnavailable } = await import("../../src/errors.ts");
	return {
		readGithubInstallation: () =>
			Effect.sync(() => ({
				id: 123,
				account: { id: 99, login: "acme", type: "Organization" },
				suspended_at: github.suspended ? "today" : null,
			})),
		githubAppRequest: () =>
			Effect.succeed({
				token: "installation-token",
				permissions: { members: github.permission ? "read" : undefined },
			}),
		exchangeGithubCode: () => Effect.succeed({ access_token: "user-token" }),
		githubRequest: (url: string) =>
			Effect.suspend<unknown, import("../../src/errors.ts").ApiError, never>(
				() => {
					if (url.includes("/user/memberships/orgs"))
						return Effect.succeed([
							{ state: "active", organization: { id: 99 } },
						]);
					if (url.endsWith("/user"))
						return Effect.succeed({ id: github.userId, login: "octocat" });
					github.reads++;
					if (github.unavailable)
						return Effect.fail(serviceUnavailable("github_app_unavailable"));
					const page = Number(new URL(url).searchParams.get("page"));
					return Effect.succeed(
						github.members
							.slice((page - 1) * 100, page * 100)
							.map((id) => ({ id })),
					);
				},
			),
	};
});
interface Member {
	id: string;
	user_id: string;
	organization_id: string;
	status: string;
	role: { slug: string };
	directory_managed?: boolean;
}
const makeMember = (user: string, role = "member"): Member => ({
	id: `m-${user}`,
	user_id: user,
	organization_id: "org-a",
	status: "active",
	role: { slug: role },
});
const makeRuntime = () =>
	ManagedRuntime.make(
		Layer.mergeAll(
			ApiStoreMemory,
			CloudWorkspaceStoreMemory,
			WorkosVerifierTest,
			configurationLayer({
				apiIssuer: "https://api.test",
				workosIssuer: "https://auth.test",
				workosJwksUrl: "unused",
				mintPrivateKey: Redacted.make("unused"),
				mintPublicKey: "unused",
				workosApiKey: Redacted.make("secret"),
				organizationWorkspacesEnabled: true,
				githubApp: {
					appId: "123",
					slug: "zuse",
					clientId: "client",
					clientSecret: Redacted.make("secret"),
					privateKey: Redacted.make("unused"),
				},
			}),
		),
	);
/** GitHub accounts each Zuse account linked through Zuse's GitHub App. */
const githubSignIns: Record<string, number> = {
	user_alice: 10,
	user_bob: 11,
	user_new: 12,
};
const policy = {
	organizationId: "org-a",
	installationId: 123,
	githubOrgId: 99,
	login: "acme",
	enabled: true,
	revision: "initial",
};

describe("GitHub organization joining", () => {
	let runtime: ReturnType<typeof makeRuntime>;
	let members: Member[];
	let invitations: {
		id: string;
		organization_id: string;
		email: string;
		state: string;
		expires_at: string;
	}[];
	let failAfterCreate: boolean;
	const call = (path: string, accountId = "user_alice", body: unknown = {}) =>
		runtime.runPromise(
			routeGithubOrganizationRequest(
				new Request(`https://api.test${path}`, {
					method: "POST",
					headers: {
						authorization: `Bearer test-token:${accountId}:org-a`,
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				}),
			),
		);
	const orgCall = (path: string, body: unknown) =>
		runtime.runPromise(
			routeOrganizationRequest(
				new Request(`https://api.test${path}`, {
					method: "POST",
					headers: {
						authorization: "Bearer test-token:user_owner:org-a",
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				}),
			),
		);
	const join = (account = "user_alice") =>
		runtime.runPromise(
			joinGithubOrganization(account, githubSignIns[account] ?? -1, {
				organizationId: "org-a",
				installationId: 123,
			}),
		);
	const sync = (account: string) =>
		runtime.runPromise(syncGithubAutoJoin(account));
	const active = (account: string) =>
		members.filter((m) => m.user_id === account && m.status === "active");
	const store = () => runtime.runPromise(ApiStore);
	beforeEach(async () => {
		github.members = [10, 11, 12];
		github.suspended = false;
		github.permission = true;
		github.unavailable = false;
		github.reads = 0;
		github.userId = 10;
		members = [makeMember("user_owner", "admin")];
		invitations = [];
		failAfterCreate = false;
		runtime = makeRuntime();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string, init?: RequestInit) => {
				const url = new URL(input);
				const method = init?.method ?? "GET";
				const body = init?.body ? JSON.parse(String(init.body)) : {};
				const json = (data: unknown) => new Response(JSON.stringify(data));
				if (url.pathname === "/user_management/organization_memberships") {
					if (method === "POST") {
						const member = makeMember(body.user_id, body.role_slug);
						member.organization_id = body.organization_id;
						members.push(member);
						if (failAfterCreate) {
							failAfterCreate = false;
							throw new Error("response lost");
						}
						return json(member);
					}
					return json({
						data: members.filter(
							(m) =>
								(!url.searchParams.has("user_id") ||
									url.searchParams.get("user_id") === m.user_id) &&
								(!url.searchParams.has("organization_id") ||
									url.searchParams.get("organization_id") ===
										m.organization_id),
						),
						list_metadata: { after: null },
					});
				}
				if (
					url.pathname.startsWith("/user_management/organization_memberships/")
				) {
					const id = url.pathname.split("/")[3];
					const member = members.find((m) => m.id === id);
					if (!member) return new Response("{}", { status: 404 });
					if (method === "DELETE") {
						members = members.filter((m) => m !== member);
						return new Response(null, { status: 204 });
					}
					if (url.pathname.endsWith("/deactivate")) member.status = "inactive";
					if (url.pathname.endsWith("/reactivate")) member.status = "active";
					return json(member);
				}
				if (url.pathname === "/user_management/invitations") {
					if (method === "POST") {
						const invite = {
							id: crypto.randomUUID(),
							organization_id: body.organization_id,
							email: body.email,
							state: "pending",
							expires_at: "2030-01-01T00:00:00Z",
						};
						invitations.push(invite);
						return json(invite);
					}
					return json({ data: invitations, list_metadata: { after: null } });
				}
				if (url.pathname.startsWith("/organizations/"))
					return json({ id: url.pathname.split("/").at(-1), name: "Acme" });
				if (url.pathname.startsWith("/user_management/users/"))
					return json({
						email: "member@example.com",
						first_name: null,
						last_name: null,
					});
				throw new Error(`Unexpected provider request ${url.pathname}`);
			}),
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				const api = yield* ApiStore;
				yield* api.githubJoining.savePolicy(policy);
				yield* api.githubJoining.saveIdentity({
					accountId: "user_alice",
					githubUserId: 10,
					login: "alice",
					organizationIds: [99],
					verificationId: "verified",
				});
				yield* api.githubJoining.saveIdentity({
					accountId: "user_bob",
					githubUserId: 11,
					login: "bob",
					organizationIds: [99],
					verificationId: "verified",
				});
				yield* (yield* CloudWorkspaceStore).saveGithubInstallation({
					accountId: "organization:org-a",
					installationId: 123,
					githubAccountId: 99,
					accountLogin: "acme",
					accountType: "Organization",
					repositorySelection: "all",
					suspended: false,
					createdAtMs: 1,
					updatedAtMs: 1,
				});
			}),
		);
	});
	afterEach(async () => {
		await runtime.dispose();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});
	it("auto-joins linked GitHub accounts listed in the roster, once, as Member", async () => {
		await runtime.runPromise(refreshGithubRosters(123));
		await sync("user_alice");
		await sync("user_alice");
		expect(members.filter((m) => m.user_id === "user_alice")).toEqual([
			makeMember("user_alice"),
		]);
	});
	it("skips accounts without a linked GitHub account or outside the roster", async () => {
		github.members = [11];
		await runtime.runPromise(refreshGithubRosters(123));
		await sync("user_unknown");
		await sync("user_alice");
		expect(active("user_unknown")).toHaveLength(0);
		expect(active("user_alice")).toHaveLength(0);
		await expect(join()).rejects.toMatchObject({
			code: "organization_access_denied",
		});
	});
	it("does not auto-join while auto-join is off", async () => {
		await runtime.runPromise(refreshGithubRosters(123));
		await runtime.runPromise(
			(await store()).githubJoining.savePolicy({ ...policy, enabled: false }),
		);
		await sync("user_alice");
		expect(active("user_alice")).toHaveLength(0);
	});
	it("joins linked roster members as soon as auto-join turns on", async () => {
		await runtime.runPromise(
			(await store()).githubJoining.savePolicy({ ...policy, enabled: false }),
		);
		await call(ApiPaths.organizationGithubPolicy, "user_owner", {
			organizationId: "org-a",
			installationId: 123,
			enabled: true,
		});
		expect(active("user_alice")).toHaveLength(1);
		expect(active("user_bob")).toHaveLength(1);
	});
	it("reports the linked GitHub account", async () => {
		expect(
			await (await call(ApiPaths.organizationGithubConnection))?.json(),
		).toEqual({ connected: true, login: "alice" });
		expect(
			await (
				await call(ApiPaths.organizationGithubConnection, "user_unknown")
			)?.json(),
		).toEqual({ connected: false });
	});
	it("paginates private membership and coalesces concurrent verification", async () => {
		github.members = [...Array.from({ length: 100 }, (_, i) => i + 100), 10];
		const values = await Promise.all(
			Array.from({ length: 8 }, () =>
				runtime.runPromise(githubMemberEligible(policy, 10)),
			),
		);
		expect(values.every(Boolean)).toBe(true);
		expect(github.reads).toBe(2);
	});
	it("counts pending invitations and serializes concurrent joins at the final seat", async () => {
		members.push(makeMember("manual1"), makeMember("manual2"));
		invitations.push({
			id: "inv",
			organization_id: "org-a",
			email: "inv@example.com",
			state: "pending",
			expires_at: "2030-01-01T00:00:00Z",
		});
		const results = await Promise.allSettled([join(), join("user_bob")]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(results.find((r) => r.status === "rejected")).toMatchObject({
			reason: { code: "organization_member_limit_reached" },
		});
		expect(members).toHaveLength(4);
	});
	it("serializes an invitation against joining", async () => {
		members.push(
			makeMember("manual1"),
			makeMember("manual2"),
			makeMember("manual3"),
		);
		const results = await Promise.allSettled([
			join(),
			orgCall(ApiPaths.organizationInvite, {
				organizationId: "org-a",
				email: "new@example.com",
				role: "member",
			}),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(members.length + invitations.length).toBe(5);
	});
	it("preserves durable enrollment when WorkOS accepts but its response is lost", async () => {
		failAfterCreate = true;
		await expect(join()).rejects.toMatchObject({
			code: "organizations_unavailable",
		});
		expect(
			await runtime.runPromise(
				(await store()).githubJoining.getEnrollment("org-a", "user_alice"),
			),
		).not.toBeNull();
		await join();
		expect(members.filter((m) => m.user_id === "user_alice")).toHaveLength(1);
	});
	it("does not convert an existing manually admitted member", async () => {
		members.push(makeMember("user_alice"));
		await join();
		expect(
			await runtime.runPromise(
				(await store()).githubJoining.getEnrollment("org-a", "user_alice"),
			),
		).toBeNull();
	});
	it("stops new joins when disabled without revoking existing GitHub members", async () => {
		await join();
		await call(ApiPaths.organizationGithubPolicy, "user_owner", {
			organizationId: "org-a",
			installationId: 123,
			enabled: false,
		});
		await expect(join("user_bob")).rejects.toMatchObject({
			code: "organization_access_denied",
		});
		await expect(
			runtime.runPromise(requireOrganizationMembership("user_alice", "org-a")),
		).resolves.toMatchObject({ status: "active" });
	});
	it("revokes departures and supports rejoining when GitHub membership returns", async () => {
		await join();
		github.members = [];
		await runtime.runPromise(invalidateGithubJoining(123));
		await runtime.runPromise(reconcileGithubMemberships(123));
		expect(members.find((m) => m.user_id === "user_alice")?.status).toBe(
			"inactive",
		);
		await expect(
			runtime.runPromise(requireOrganizationMembership("user_alice", "org-a")),
		).rejects.toMatchObject({ code: "organization_access_denied" });
		github.members = [10];
		await runtime.runPromise(invalidateGithubJoining(123));
		await join();
		expect(members.find((m) => m.user_id === "user_alice")?.status).toBe(
			"active",
		);
	});
	it("blocks reconnect access on suspension without deactivating membership", async () => {
		await join();
		github.suspended = true;
		await runtime.runPromise(invalidateGithubJoining(123));
		await expect(
			runtime.runPromise(requireOrganizationMembership("user_alice", "org-a")),
		).rejects.toMatchObject({ code: "github_installation_unavailable" });
		expect(members.find((m) => m.user_id === "user_alice")?.status).toBe(
			"active",
		);
	});
	it("denies disconnected installations even when a successful roster is cached", async () => {
		await join();
		await runtime.runPromise(
			Effect.flatMap(CloudWorkspaceStore, (s) =>
				s.removeGithubInstallation("organization:org-a", 123),
			),
		);
		await expect(
			runtime.runPromise(requireOrganizationMembership("user_alice", "org-a")),
		).rejects.toMatchObject({ code: "github_installation_unavailable" });
	});
	it("expires successful checks and fails closed during an outage", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		await join();
		github.unavailable = true;
		await runtime.runPromise(
			requireOrganizationMembership("user_alice", "org-a"),
		);
		vi.setSystemTime(Date.now() + 61_000);
		await expect(
			runtime.runPromise(requireOrganizationMembership("user_alice", "org-a")),
		).rejects.toMatchObject({ code: "github_app_unavailable" });
		expect(members.find((m) => m.user_id === "user_alice")?.status).toBe(
			"active",
		);
	});
	it("admin removal blocks rejoining until explicitly restored", async () => {
		await join();
		await orgCall(ApiPaths.organizationRemoveMember, {
			organizationId: "org-a",
			memberId: "m-user_alice",
		});
		await expect(join()).rejects.toMatchObject({
			code: "organization_access_denied",
		});
		await call(ApiPaths.organizationGithubRestore, "user_owner", {
			organizationId: "org-a",
			accountId: "user_alice",
		});
		await join();
	});
	it("forbids role promotion for GitHub-managed memberships", async () => {
		await join();
		await expect(
			orgCall(ApiPaths.organizationSetRole, {
				organizationId: "org-a",
				memberId: "m-user_alice",
				role: "admin",
			}),
		).rejects.toMatchObject({ code: "organization_member_managed" });
	});
	it("requires admin authority, connected ownership and Members permission for enabling", async () => {
		await expect(
			call(ApiPaths.organizationGithubPolicy, "user_alice", {
				organizationId: "org-a",
				installationId: 123,
				enabled: true,
			}),
		).rejects.toMatchObject({ code: "organization_access_denied" });
		await expect(
			call(ApiPaths.organizationGithubPolicy, "user_owner", {
				organizationId: "org-a",
				installationId: 456,
				enabled: true,
			}),
		).rejects.toMatchObject({ code: "github_installation_not_connected" });
		github.permission = false;
		await expect(
			call(ApiPaths.organizationGithubPolicy, "user_owner", {
				organizationId: "org-a",
				installationId: 123,
				enabled: true,
			}),
		).rejects.toMatchObject({ code: "github_members_permission_required" });
	});
	it("binds single-use OAuth state to the account and browser", async () => {
		github.userId = 12;
		const result = await (
			await call(ApiPaths.organizationGithubAuthorize, "user_new")
		)?.json();
		const start = await runtime.runPromise(
			routeGithubOrganizationRequest(new Request(result.url)),
		);
		const cookie = start?.headers.get("set-cookie")?.split(";")[0] ?? "";
		const callback = new URL(result.url);
		callback.searchParams.set("code", "verified-code");
		await expect(
			runtime.runPromise(routeGithubOrganizationRequest(new Request(callback))),
		).rejects.toMatchObject({ code: "invalid_github_browser_state" });
		const response = await runtime.runPromise(
			routeGithubOrganizationRequest(
				new Request(callback, { headers: { cookie } }),
			),
		);
		expect(response?.status).toBe(200);
		expect(
			await runtime.runPromise(
				(await store()).githubJoining.getIdentity("user_new"),
			),
		).toMatchObject({ githubUserId: 12 });
		await expect(
			runtime.runPromise(
				routeGithubOrganizationRequest(
					new Request(callback, { headers: { cookie } }),
				),
			),
		).rejects.toMatchObject({ code: "invalid_github_join_state" });
	});
	it("prevents linking one GitHub identity to multiple Zuse accounts", async () => {
		expect(
			await runtime.runPromise(
				(await store()).githubJoining.saveIdentity({
					accountId: "user_other",
					githubUserId: 10,
					login: "alice",
					organizationIds: [99],
					verificationId: "verified",
				}),
			),
		).toBe(false);
	});
	it("expires OAuth state without linking an identity", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const result = await (
			await call(ApiPaths.organizationGithubAuthorize, "user_new")
		)?.json();
		const start = await runtime.runPromise(
			routeGithubOrganizationRequest(new Request(result.url)),
		);
		const cookie = start?.headers.get("set-cookie")?.split(";")[0] ?? "";
		const callback = new URL(result.url);
		callback.searchParams.set("code", "verified-code");
		vi.setSystemTime(Date.now() + 601_000);
		await expect(
			runtime.runPromise(
				routeGithubOrganizationRequest(
					new Request(callback, { headers: { cookie } }),
				),
			),
		).rejects.toMatchObject({ code: "invalid_github_join_state" });
		expect(
			await runtime.runPromise(
				(await store()).githubJoining.getIdentity("user_new"),
			),
		).toBeNull();
	});
	it("auto-joins when GitHub is linked and lets an account switch GitHub accounts", async () => {
		const link = async (accountId: string) => {
			const result = await (
				await call(ApiPaths.organizationGithubAuthorize, accountId)
			)?.json();
			const start = await runtime.runPromise(
				routeGithubOrganizationRequest(new Request(result.url)),
			);
			const cookie = start?.headers.get("set-cookie")?.split(";")[0] ?? "";
			const callback = new URL(result.url);
			callback.searchParams.set("code", "verified-code");
			return runtime.runPromise(
				routeGithubOrganizationRequest(
					new Request(callback, { headers: { cookie } }),
				),
			);
		};
		await runtime.runPromise(refreshGithubRosters(123));
		github.userId = 12;
		expect(await (await link("user_new"))?.text()).toContain("You joined Acme");
		expect(active("user_new")).toHaveLength(1);
		github.members = [10, 11, 12, 13];
		github.userId = 13;
		await link("user_new");
		expect(
			await runtime.runPromise(
				(await store()).githubJoining.getIdentity("user_new"),
			),
		).toMatchObject({ githubUserId: 13 });
	});
	it("rechecks gateway and queued-command authority after a GitHub departure", async () => {
		await join();
		const workspace = {
			accountId: "organization:org-a",
			requestConfig: {
				sharingPolicy: {
					audience: "organization",
					permission: "edit",
					creatorSubject: "user_owner",
					creatorMembershipId: "m-user_owner",
					grants: [],
				},
			},
		};
		await expect(
			runtime.runPromise(
				cloudWorkspaceActorPermission(workspace, "user_alice", "m-user_alice"),
			),
		).resolves.toMatchObject({ permission: "edit" });
		github.members = [];
		await runtime.runPromise(invalidateGithubJoining(123));
		await expect(
			runtime.runPromise(
				cloudWorkspaceActorPermission(workspace, "user_alice", "m-user_alice"),
			),
		).rejects.toMatchObject({ status: 403 });
	});
});
