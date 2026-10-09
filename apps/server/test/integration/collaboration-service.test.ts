import {
	type ChatId,
	CollaborationAccessDeniedError,
	Organization,
	OrganizationDetails,
	OrganizationMember,
	OrganizationsRemoveMemberRpc,
	OrganizationsSetRoleRpc,
} from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime, PubSub, Stream } from "effect";
import { RpcGroup, RpcTest } from "effect/unstable/rpc";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthTokenError } from "../../src/auth/errors.ts";
import { AuthService } from "../../src/auth/services/auth-service.ts";
import { CollaborationServiceLive } from "../../src/collaboration/layers/collaboration-service.ts";
import { OrganizationHandlersLayer } from "../../src/collaboration/organization-handlers.ts";
import { CollaborationService } from "../../src/collaboration/services/collaboration-service.ts";
import { OrganizationAuthority } from "../../src/collaboration/services/organization-authority.ts";
import { WorkspaceSharingAuthorityLive } from "../../src/collaboration/services/workspace-sharing-authority.ts";
import { ConnectionIdentity } from "../../src/lan-auth/services/connection-identity.ts";
import { MachineControlServiceLive } from "../../src/machine/machine-control-service.ts";
import { MachineRuntimeRole } from "../../src/machine/machine-runtime-role.ts";
import { MigrationsLive } from "../../src/persistence/migrations.ts";

const makeRuntime = (
	authorized = () => true,
	membershipId = (organizationId: string, subject: string) =>
		`${organizationId}-${subject}`,
) => {
	const sqlite = sqliteLayer({ filename: ":memory:", disableWAL: true });
	const database = Layer.merge(
		sqlite,
		MigrationsLive.pipe(Layer.provide(sqlite)),
	);
	return ManagedRuntime.make(
		CollaborationServiceLive.pipe(
			Layer.provide(
				WorkspaceSharingAuthorityLive.pipe(
					Layer.provide(
						Layer.succeed(AuthService, {
							getSession: () => Effect.succeed({ _tag: "SignedOut" }),
							signIn: () => Effect.succeed({ _tag: "SignedOut" }),
							signOut: () => Effect.void,
							sessionChanges: () => Stream.empty,
							getAccessToken: () =>
								Effect.fail(new AuthTokenError({ reason: "Not signed in." })),
						}),
					),
				),
			),
			Layer.provideMerge(database),
			Layer.provide(
				Layer.succeed(OrganizationAuthority, {
					membership: (organizationId, subject) =>
						authorized()
							? Effect.succeed({
									role:
										subject === "owner"
											? ("owner" as const)
											: ("driver" as const),
									membershipId: membershipId(organizationId, subject),
								})
							: Effect.fail(
									new CollaborationAccessDeniedError({
										reason: "membership_not_active",
									}),
								),
				}),
			),
		),
	);
};

type TestRuntime = ReturnType<typeof makeRuntime>;

const organizationRoster = (
	id: string,
	includeDriver = true,
	driverRole = "member",
) =>
	OrganizationDetails.make({
		organization: Organization.make({ id, name: id, role: "admin" }),
		currentUserId: "owner",
		members: [
			OrganizationMember.make({
				id: `${id}-owner`,
				userId: "owner",
				email: "owner@example.com",
				displayName: "Owner",
				role: "admin",
				directoryManaged: false,
			}),
			...(includeDriver
				? [
						OrganizationMember.make({
							id: `${id}-driver`,
							userId: "driver",
							email: "driver@example.com",
							displayName: "Driver",
							role: driverRole,
							directoryManaged: false,
						}),
					]
				: []),
		],
		invitations: [],
	});

describe("CollaborationService", () => {
	let runtime: TestRuntime;

	beforeEach(() => {
		runtime = makeRuntime();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await runtime.dispose();
	});

	test("organization mutation RPCs restrict local access only after the account API confirms success", async () => {
		let accepted = false;
		const requests: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			requests.push(String(url));
			return Response.json(accepted ? { ok: true } : { error: "forbidden" }, {
				status: accepted ? 200 : 403,
			});
		});
		const machine = MachineControlServiceLive.pipe(
			Layer.provide(Layer.succeed(MachineRuntimeRole, "control-plane")),
			Layer.provide(
				Layer.succeed(AuthService, {
					getSession: () => Effect.succeed({ _tag: "SignedOut" }),
					signIn: () => Effect.die("unused"),
					signOut: () => Effect.void,
					sessionChanges: () => Stream.empty,
					getAccessToken: () => Effect.succeed("test-account-token"),
				}),
			),
		);
		const clientEffect = RpcTest.makeClient(
			RpcGroup.make(OrganizationsRemoveMemberRpc, OrganizationsSetRoleRpc),
			{ flatten: true },
		);
		await runtime.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* CollaborationService;
					const { team, actor } = yield* service.synchronizeOrganization(
						organizationRoster("org-a", true, "admin"),
					);
					const driver = yield* service.resolveActor(team.id, "driver");
					const subscription = yield* service.subscribeAccessRevocations;
					const client = yield* clientEffect;
					const input = { organizationId: "org-a", memberId: "org-a-driver" };
					expect(
						yield* client("organizations.removeMember", input).pipe(
							Effect.flip,
						),
					).toMatchObject({ _tag: "OrganizationError", code: "not-allowed" });
					expect(yield* PubSub.takeUpTo(subscription, 10)).toEqual([]);
					expect(
						(yield* service.listMembers(actor)).find(
							(member) => member.id === driver.memberId,
						)?.role,
					).toBe("owner");
					accepted = true;
					yield* client("organizations.setRole", { ...input, role: "member" });
					expect(yield* PubSub.takeUpTo(subscription, 10)).toEqual([
						{ kind: "member", memberId: driver.memberId },
					]);
					expect(
						(yield* service.listMembers(actor)).find(
							(member) => member.id === driver.memberId,
						)?.role,
					).toBe("driver");
					yield* client("organizations.removeMember", input);
					expect(yield* PubSub.takeUpTo(subscription, 10)).toEqual([
						{ kind: "member", memberId: driver.memberId },
					]);
					expect(
						yield* service.resolveActor(team.id, "driver").pipe(Effect.flip),
					).toMatchObject({ reason: "membership_not_active" });
				}),
			).pipe(
				Effect.provide(OrganizationHandlersLayer),
				Effect.provide(machine),
			),
		);
		expect(requests.map((url) => new URL(url).pathname)).toEqual([
			"/v1/organizations/remove-member",
			"/v1/organizations/set-role",
			"/v1/organizations/remove-member",
		]);
	});

	test.each([
		"removed",
		"billing",
	])("signals committed %s revocations without invalidating unchanged rosters", async (change) => {
		await runtime.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* CollaborationService;
					const subscription = yield* service.subscribeAccessRevocations;
					const { team } = yield* service.synchronizeOrganization(
						organizationRoster("org-a"),
					);
					const driver = yield* service.resolveActor(team.id, "driver");
					yield* service.synchronizeOrganization(organizationRoster("org-a"));
					expect(yield* PubSub.takeUpTo(subscription, 10)).toEqual([]);
					yield* service.synchronizeOrganization(
						organizationRoster("org-a", change !== "removed", "billing"),
					);
					expect(yield* PubSub.takeUpTo(subscription, 10)).toEqual([
						{ kind: "member", memberId: driver.memberId },
					]);
					yield* service.synchronizeOrganization(
						organizationRoster("org-a", change !== "removed", "billing"),
					);
					expect(yield* PubSub.takeUpTo(subscription, 10)).toEqual([]);
				}),
			),
		);
	});

	test("lists only explicitly shared workspaces and rechecks live organization membership", async () => {
		let authorized = true;
		const isolated = makeRuntime(() => authorized);
		try {
			await isolated.runPromise(
				Effect.gen(function* () {
					const service = yield* CollaborationService;
					const sql = yield* SqlClient.SqlClient;
					const { team, actor } = yield* service.synchronizeOrganization(
						organizationRoster("org-visible"),
					);
					const driver = yield* service.resolveActor(team.id, "driver");
					const now = new Date().toISOString();
					yield* sql`INSERT INTO projects (id, path, name, created_at, updated_at) VALUES ('p', '/tmp/p', 'P', ${now}, ${now})`;
					yield* sql`INSERT INTO chats (id, project_id, title, created_at, updated_at) VALUES ('shared', 'p', 'Shared', ${now}, ${now}), ('private', 'p', 'Private', ${now}, ${now})`;
					const chatId = "shared" as ChatId;
					expect(yield* service.visibleWorkspaces("owner")).toEqual([]);
					expect(yield* service.connectionAudience).toEqual([]);
					yield* service
						.shareWorkspace(actor, chatId)
						.pipe(Effect.provideService(ConnectionIdentity, { kind: "local" }));
					expect(yield* service.visibleWorkspaces("owner")).toEqual([
						{ chatId: "shared", projectId: "p" },
					]);
					expect(yield* service.visibleWorkspaces("driver")).toEqual([]);
					expect(yield* service.connectionAudience).toEqual([
						{
							organizationId: "org-visible",
							membershipId: "org-visible-owner",
							subject: "owner",
							adminOnly: true,
						},
					]);
					yield* service.setWorkspaceGrant(
						actor,
						chatId,
						driver.memberId,
						"viewer",
					);
					expect(yield* service.visibleWorkspaces("driver")).toEqual([
						{ chatId: "shared", projectId: "p" },
					]);
					expect(yield* service.visibleWorkspaces("stranger")).toEqual([]);
					expect(yield* service.connectionAudience).toEqual([
						{
							organizationId: "org-visible",
							membershipId: "org-visible-driver",
							subject: "driver",
							adminOnly: false,
						},
						{
							organizationId: "org-visible",
							membershipId: "org-visible-owner",
							subject: "owner",
							adminOnly: true,
						},
					]);
					authorized = false;
					expect(yield* service.visibleWorkspaces("owner")).toEqual([]);
					expect(yield* service.visibleWorkspaces("driver")).toEqual([]);
					authorized = true;
					yield* service.removeWorkspaceGrant(actor, chatId, driver.memberId);
					expect(yield* service.visibleWorkspaces("driver")).toEqual([]);
					expect(
						(yield* service.connectionAudience).map((entry) => entry.subject),
					).toEqual(["owner"]);
					yield* service
						.unshareWorkspace(actor, chatId)
						.pipe(Effect.provideService(ConnectionIdentity, { kind: "local" }));
					expect(yield* service.connectionAudience).toEqual([]);
				}),
			);
		} finally {
			await isolated.dispose();
		}
	});

	test("applies confirmed membership restrictions by organization and membership ID without a roster refresh", async () => {
		await runtime.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* CollaborationService;
					const sql = yield* SqlClient.SqlClient;
					const { team, actor } = yield* service.synchronizeOrganization(
						organizationRoster("org-a", true, "admin"),
					);
					yield* service.synchronizeOrganization(organizationRoster("org-b"));
					const driver = yield* service.resolveActor(team.id, "driver");
					const subscription = yield* service.subscribeAccessRevocations;
					const now = new Date().toISOString();
					yield* sql`INSERT INTO projects (id, path, name, created_at, updated_at) VALUES ('p', '/tmp/p', 'P', ${now}, ${now})`;
					yield* sql`INSERT INTO chats (id, project_id, title, created_at, updated_at) VALUES ('c', 'p', 'C', ${now}, ${now})`;
					const chatId = "c" as ChatId;
					yield* service
						.shareWorkspace(actor, chatId)
						.pipe(Effect.provideService(ConnectionIdentity, { kind: "local" }));
					yield* service.setWorkspaceGrant(
						actor,
						chatId,
						driver.memberId,
						"viewer",
					);
					yield* service.applyOrganizationMembershipRestriction({
						organizationId: "org-b",
						memberId: "org-a-driver",
						change: "removed",
					});
					expect(yield* PubSub.takeUpTo(subscription, 10)).toEqual([]);
					expect(
						yield* service.listWorkspaceGrants(actor, chatId),
					).toHaveLength(1);
					yield* service.applyOrganizationMembershipRestriction({
						organizationId: "org-a",
						memberId: "org-a-driver",
						change: "demoted",
					});
					expect(yield* PubSub.takeUpTo(subscription, 10)).toEqual([
						{ kind: "member", memberId: driver.memberId },
					]);
					expect(
						(yield* service.listMembers(actor)).find(
							(member) => member.id === driver.memberId,
						)?.role,
					).toBe("driver");
					expect(
						yield* service.listWorkspaceGrants(actor, chatId),
					).toHaveLength(0);
					yield* service.setWorkspaceGrant(
						actor,
						chatId,
						driver.memberId,
						"viewer",
					);
					yield* service.applyOrganizationMembershipRestriction({
						organizationId: "org-a",
						memberId: "org-a-driver",
						change: "demoted",
					});
					expect(yield* PubSub.takeUpTo(subscription, 10)).toEqual([]);
					expect(
						yield* service.listWorkspaceGrants(actor, chatId),
					).toHaveLength(1);
					yield* service.applyOrganizationMembershipRestriction({
						organizationId: "org-a",
						memberId: "org-a-driver",
						change: "removed",
					});
					expect(yield* PubSub.takeUpTo(subscription, 10)).toEqual([
						{ kind: "member", memberId: driver.memberId },
					]);
					expect(
						yield* service.resolveActor(team.id, "driver").pipe(Effect.flip),
					).toMatchObject({ reason: "membership_not_active" });
					expect(
						yield* service.listWorkspaceGrants(actor, chatId),
					).toHaveLength(0);
					yield* service.applyOrganizationMembershipRestriction({
						organizationId: "org-a",
						memberId: "org-a-driver",
						change: "removed",
					});
					expect(yield* PubSub.takeUpTo(subscription, 10)).toEqual([]);
				}),
			),
		);
	});

	test("rechecks live organization membership even when SQLite still records an owner", async () => {
		let authorized = true;
		const isolated = makeRuntime(() => authorized);
		try {
			await isolated.runPromise(
				Effect.gen(function* () {
					const service = yield* CollaborationService;
					const { actor } = yield* service.synchronizeOrganization(
						organizationRoster("org-a"),
					);
					yield* service.listMembers(actor);
					authorized = false;
					expect(
						(yield* service.listMembers(actor).pipe(Effect.flip)).reason,
					).toBe("membership_not_active");
				}),
			);
		} finally {
			await isolated.dispose();
		}
	});

	test("synchronizes WorkOS organizations idempotently without a second invitation authority", async () => {
		await runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* CollaborationService;
				const first = yield* service.synchronizeOrganization(
					organizationRoster("org-a"),
				);
				const again = yield* service.synchronizeOrganization(
					organizationRoster("org-a"),
				);
				const other = yield* service.synchronizeOrganization(
					organizationRoster("org-b"),
				);
				expect(first.team.organizationId).toBe("org-a");
				expect(again.actor.memberId).toBe(first.actor.memberId);
				expect(other.team.id).not.toBe(first.team.id);
				expect(
					(yield* service.listAuditEvents(first.actor)).filter(
						(event) => event.action === "organization.synchronized",
					),
				).toHaveLength(1);
			}),
		);
	});

	test("isolates organization workspaces even from other organization owners and clears revoked grants", async () => {
		await runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* CollaborationService;
				const sql = yield* SqlClient.SqlClient;
				const first = yield* service.synchronizeOrganization(
					organizationRoster("org-a"),
				);
				const other = yield* service.synchronizeOrganization(
					organizationRoster("org-b"),
				);
				const driver = yield* service.resolveActor(first.team.id, "driver");
				const now = new Date().toISOString();
				yield* sql`INSERT INTO projects (id, path, name, created_at, updated_at) VALUES ('project-org', '/tmp/project-org', 'Org', ${now}, ${now})`;
				yield* sql`INSERT INTO chats (id, project_id, title, created_at, updated_at) VALUES ('chat-org', 'project-org', 'Private', ${now}, ${now})`;
				const chatId = "chat-org" as ChatId;
				expect(
					yield* service
						.getWorkspaceSharing(first.actor, chatId)
						.pipe(Effect.flip),
				).toMatchObject({ reason: "host_authorization_required" });
				expect(
					yield* service
						.getWorkspaceSharing(first.actor, chatId)
						.pipe(Effect.provideService(ConnectionIdentity, { kind: "local" })),
				).toEqual({ shared: false, grants: [] });
				expect(
					yield* service
						.setWorkspaceGrant(first.actor, chatId, driver.memberId, "driver")
						.pipe(Effect.flip),
				).toMatchObject({ reason: "workspace_not_shared" });
				expect(
					yield* service.shareWorkspace(first.actor, chatId).pipe(Effect.flip),
				).toMatchObject({ reason: "host_authorization_required" });
				expect(
					yield* service.shareWorkspace(first.actor, chatId).pipe(
						Effect.provideService(ConnectionIdentity, {
							kind: "account",
							subject: first.actor.subject,
							expiresAt: Date.now() + 60_000,
						}),
						Effect.flip,
					),
				).toMatchObject({ reason: "host_authorization_required" });
				yield* service
					.shareWorkspace(first.actor, chatId)
					.pipe(Effect.provideService(ConnectionIdentity, { kind: "local" }));
				expect(
					yield* service
						.shareWorkspace(other.actor, chatId)
						.pipe(
							Effect.provideService(ConnectionIdentity, { kind: "local" }),
							Effect.flip,
						),
				).toMatchObject({ reason: "workspace_belongs_to_another_team" });
				expect(
					yield* service
						.shareWorkspace(driver, chatId)
						.pipe(
							Effect.provideService(ConnectionIdentity, { kind: "local" }),
							Effect.flip,
						),
				).toMatchObject({ _tag: "CollaborationAccessDeniedError" });
				yield* service
					.shareWorkspace(first.actor, chatId)
					.pipe(Effect.provideService(ConnectionIdentity, { kind: "local" }));
				const sharingEvents =
					yield* sql`SELECT id FROM collaboration_audit_events WHERE action = 'workspace.shared' AND resource_id = ${chatId}`;
				expect(sharingEvents).toHaveLength(1);
				yield* service.setWorkspaceGrant(
					first.actor,
					chatId,
					driver.memberId,
					"driver",
				);
				const crossTeamInsert = yield* sql`INSERT INTO collaboration_chat_grants
					(team_id, chat_id, member_id, role, granted_by_member_id, created_at, updated_at)
					VALUES (${first.team.id}, ${chatId}, ${other.actor.memberId}, 'viewer', ${first.actor.memberId}, ${now}, ${now})`.pipe(
					Effect.flip,
				);
				expect(crossTeamInsert._tag).toBe("SqlError");
				const sharing = yield* service
					.getWorkspaceSharing(first.actor, chatId)
					.pipe(Effect.provideService(ConnectionIdentity, { kind: "local" }));
				expect(sharing.shared).toBe(true);
				expect(sharing.grants).toHaveLength(1);
				expect(sharing.grants[0]?.memberId).toBe(driver.memberId);
				expect(
					yield* service
						.getWorkspaceSharing(other.actor, chatId)
						.pipe(
							Effect.provideService(ConnectionIdentity, { kind: "local" }),
							Effect.flip,
						),
				).toMatchObject({ reason: "workspace_belongs_to_another_team" });
				expect(
					yield* service
						.unshareWorkspace(first.actor, chatId)
						.pipe(Effect.flip),
				).toMatchObject({ reason: "host_authorization_required" });
				yield* service
					.unshareWorkspace(first.actor, chatId)
					.pipe(Effect.provideService(ConnectionIdentity, { kind: "local" }));
				yield* service
					.unshareWorkspace(first.actor, chatId)
					.pipe(Effect.provideService(ConnectionIdentity, { kind: "local" }));
				expect(
					yield* sql`SELECT id FROM collaboration_audit_events WHERE action = 'workspace.unshared' AND resource_id = ${chatId}`,
				).toHaveLength(1);
				expect(
					yield* sql`SELECT id FROM chats WHERE id = ${chatId}`,
				).toHaveLength(1);
				expect(
					yield* service
						.getWorkspaceSharing(first.actor, chatId)
						.pipe(Effect.provideService(ConnectionIdentity, { kind: "local" })),
				).toEqual({ shared: false, grants: [] });
				expect(
					yield* service
						.requireWorkspaceRole(first.actor, chatId, "viewer")
						.pipe(Effect.flip),
				).toMatchObject({ reason: "workspace_role_required" });
				yield* service
					.shareWorkspace(first.actor, chatId)
					.pipe(Effect.provideService(ConnectionIdentity, { kind: "local" }));
				expect(
					yield* service
						.requireWorkspaceRole(driver, chatId, "viewer")
						.pipe(Effect.flip),
				).toMatchObject({ reason: "workspace_role_required" });
				yield* service.setWorkspaceGrant(
					first.actor,
					chatId,
					driver.memberId,
					"driver",
				);
				expect(
					(yield* service
						.requireWorkspaceRole(other.actor, chatId, "viewer")
						.pipe(Effect.flip)).reason,
				).toBe("workspace_role_required");
				expect(
					(yield* service
						.setWorkspaceGrant(
							other.actor,
							chatId,
							other.actor.memberId,
							"owner",
						)
						.pipe(Effect.flip))._tag,
				).toBe("CollaborationAccessDeniedError");
				yield* service.synchronizeOrganization(
					organizationRoster("org-a", false),
				);
				expect(
					(yield* service
						.requireWorkspaceRole(driver, chatId, "viewer")
						.pipe(Effect.flip))._tag,
				).toBe("CollaborationAccessDeniedError");
				yield* service.synchronizeOrganization(organizationRoster("org-a"));
				expect(
					(yield* service
						.requireWorkspaceRole(driver, chatId, "viewer")
						.pipe(Effect.flip)).reason,
				).toBe("workspace_role_required");
			}),
		);
	});

	test("a replacement WorkOS membership cannot inherit an old private grant even when removal was not observed", async () => {
		let replacement = false;
		const isolated = makeRuntime(
			() => true,
			(organizationId, subject) =>
				`${organizationId}-${subject}${replacement && subject === "driver" ? "-new" : ""}`,
		);
		try {
			await isolated.runPromise(
				Effect.gen(function* () {
					const service = yield* CollaborationService;
					const sql = yield* SqlClient.SqlClient;
					const roster = organizationRoster("org-a");
					const { actor, team } =
						yield* service.synchronizeOrganization(roster);
					const driver = yield* service.resolveActor(team.id, "driver");
					const now = new Date().toISOString();
					yield* sql`INSERT INTO projects (id, path, name, created_at, updated_at) VALUES ('project-rejoin', '/tmp/project-rejoin', 'Org', ${now}, ${now})`;
					yield* sql`INSERT INTO chats (id, project_id, title, created_at, updated_at) VALUES ('chat-rejoin', 'project-rejoin', 'Private', ${now}, ${now})`;
					const chatId = "chat-rejoin" as ChatId;
					yield* service
						.shareWorkspace(actor, chatId)
						.pipe(Effect.provideService(ConnectionIdentity, { kind: "local" }));
					yield* service.setWorkspaceGrant(
						actor,
						chatId,
						driver.memberId,
						"driver",
					);
					replacement = true;
					expect(
						(yield* service
							.requireWorkspaceRole(driver, chatId, "viewer")
							.pipe(Effect.flip)).reason,
					).toBe("organization_membership_changed");
					yield* service.synchronizeOrganization(
						OrganizationDetails.make({
							...roster,
							members: roster.members.map((member) =>
								member.userId === "driver"
									? OrganizationMember.make({
											...member,
											id: `${member.id}-new`,
										})
									: member,
							),
						}),
					);
					expect(
						(yield* service
							.requireWorkspaceRole(driver, chatId, "viewer")
							.pipe(Effect.flip)).reason,
					).toBe("workspace_role_required");
					yield* service.setWorkspaceGrant(
						actor,
						chatId,
						driver.memberId,
						"driver",
					);
					yield* service.requireWorkspaceRole(driver, chatId, "driver");
				}),
			);
		} finally {
			await isolated.dispose();
		}
	});

	test.each([
		"custom",
		"billing",
	])("denies content to WorkOS role %s and rejects incomplete rosters", async (role) => {
		await runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* CollaborationService;
				const synced = yield* service.synchronizeOrganization(
					organizationRoster("org-a", true, role),
				);
				expect(
					(yield* service.listMembers(synced.actor)).find(
						(member) => member.subject === "driver",
					)?.role,
				).toBeUndefined();
				expect(
					(yield* service
						.resolveActor(synced.team.id, "driver")
						.pipe(Effect.flip))._tag,
				).toBe("CollaborationAccessDeniedError");
				expect(
					(yield* service
						.synchronizeOrganization(
							OrganizationDetails.make({
								...organizationRoster("org-a"),
								currentUserId: "missing",
							}),
						)
						.pipe(Effect.flip))._tag,
				).toBe("CollaborationAccessDeniedError");
			}),
		);
	});

	test("enforces team role ceilings, private grants, and revocation", async () => {
		const result = await runtime.runPromise(
			Effect.gen(function* () {
				const collaboration = yield* CollaborationService;
				const sql = yield* SqlClient.SqlClient;
				const { team, actor: owner } =
					yield* collaboration.synchronizeOrganization(
						organizationRoster("org-a"),
					);
				const driver = yield* collaboration.resolveActor(team.id, "driver");
				const member = { id: driver.memberId };
				const now = new Date().toISOString();
				yield* sql`
					INSERT INTO projects (id, path, name, created_at, updated_at)
					VALUES ('project-collab', '/tmp/project-collab', 'Project', ${now}, ${now})
				`;
				yield* sql`
					INSERT INTO chats (id, project_id, title, created_at, updated_at)
					VALUES ('chat-collab', 'project-collab', 'Private chat', ${now}, ${now})
				`;
				return { collaboration, owner, driver, member };
			}),
		);

		const chatId = "chat-collab" as ChatId;
		await runtime.runPromise(
			result.collaboration
				.shareWorkspace(result.owner, chatId)
				.pipe(Effect.provideService(ConnectionIdentity, { kind: "local" })),
		);
		await expect(
			runtime.runPromise(
				result.collaboration.requireWorkspaceRole(
					result.driver,
					chatId,
					"viewer",
				),
			),
		).rejects.toMatchObject({
			_tag: "CollaborationAccessDeniedError",
			reason: "workspace_role_required",
		});

		await expect(
			runtime.runPromise(
				result.collaboration.setWorkspaceGrant(
					result.owner,
					chatId,
					result.member.id,
					"owner",
				),
			),
		).rejects.toMatchObject({
			_tag: "CollaborationAccessDeniedError",
			reason: "grant_exceeds_team_role",
		});

		const grant = await runtime.runPromise(
			result.collaboration.setWorkspaceGrant(
				result.owner,
				chatId,
				result.member.id,
				"driver",
			),
		);
		expect(grant.role).toBe("driver");
		await expect(
			runtime.runPromise(
				result.collaboration.requireWorkspaceRole(
					result.driver,
					chatId,
					"driver",
				),
			),
		).resolves.toMatchObject({ role: "driver" });
		await expect(
			runtime.runPromise(
				result.collaboration.requireWorkspaceRole(
					result.driver,
					chatId,
					"owner",
				),
			),
		).rejects.toMatchObject({
			_tag: "CollaborationAccessDeniedError",
			reason: "workspace_role_required",
		});

		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					UPDATE collaboration_members SET status = 'revoked'
					WHERE id = ${result.member.id}
				`;
			}),
		);
		await expect(
			runtime.runPromise(
				result.collaboration.requireWorkspaceRole(
					result.driver,
					chatId,
					"viewer",
				),
			),
		).rejects.toMatchObject({
			_tag: "CollaborationAccessDeniedError",
			reason: "actor_not_authorized",
		});
	});
});
