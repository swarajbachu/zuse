import {
	AuthState,
	ChatId,
	ConnectHandshakeRpc,
	FolderId,
	MemoizeRpcs,
	Organization,
	OrganizationDetails,
	OrganizationMember,
	PingResult,
	PingRpc,
	RpcAccessDeniedError,
	RpcAuthorization,
	SessionId,
	WireWelcome,
	WORKSPACE_SCOPE_HEADER,
	WorktreeId,
} from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
import {
	Deferred,
	Effect,
	Layer,
	ManagedRuntime,
	Schema,
	Stream,
} from "effect";
import { Rpc, RpcClient, RpcGroup, RpcTest } from "effect/unstable/rpc";
import { SqlClient } from "effect/unstable/sql";
import { expect, it, vi } from "vitest";
import { AuthService } from "../../src/auth/services/auth-service.ts";
import { CollaborationServiceLive } from "../../src/collaboration/layers/collaboration-service.ts";
import {
	filterCatalog,
	withCatalogChanges,
} from "../../src/collaboration/services/catalog-visibility.ts";
import { CollaborationService } from "../../src/collaboration/services/collaboration-service.ts";
import { OrganizationAuthority } from "../../src/collaboration/services/organization-authority.ts";
import { WorkspaceFileAccess } from "../../src/collaboration/services/workspace-file-access.ts";
import { WorkspaceSharingAuthorityLive } from "../../src/collaboration/services/workspace-sharing-authority.ts";
import { RpcAuthorizationLive } from "../../src/lan-auth/layers/rpc-authorization.ts";
import { ConnectionIdentity } from "../../src/lan-auth/services/connection-identity.ts";
import { RequestWorkspace } from "../../src/machine/request-workspace.ts";
import { MigrationsLive } from "../../src/persistence/migrations.ts";

const Rpcs = RpcGroup.make(
	ConnectHandshakeRpc,
	PingRpc,
	Rpc.make("fs.watchTree", {
		payload: {
			folderId: FolderId,
			worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
		},
		success: Schema.String,
		stream: true,
	}),
	Rpc.make("fs.tree", {
		payload: {
			folderId: FolderId,
			worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
		},
		success: Schema.String,
	}),
	Rpc.make("fs.listPaths", {
		payload: {
			folderId: FolderId,
			worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
		},
		success: Schema.String,
	}),
	Rpc.make("fs.readFile", {
		payload: {
			folderId: FolderId,
			path: Schema.String,
			worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
		},
		success: Schema.String,
	}),
	Rpc.make("fs.writeFile", {
		payload: {
			folderId: FolderId,
			path: Schema.String,
			worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
		},
		success: Schema.String,
	}),
	Rpc.make("chat.streamChanges", {
		payload: { projectId: FolderId },
		success: Schema.Array(Schema.String),
		stream: true,
	}),
	Rpc.make("session.streamChanges", {
		payload: { projectId: FolderId },
		success: Schema.Array(Schema.String),
		stream: true,
	}),
	Rpc.make("chat.creation.stream", {
		payload: { projectId: FolderId },
		success: Schema.Array(Schema.String),
		stream: true,
	}),
	Rpc.make("chat.creation.list", {
		payload: { projectId: FolderId },
		success: Schema.Array(Schema.String),
	}),
	Rpc.make("chat.list", {
		payload: { projectId: FolderId },
		success: Schema.Array(Schema.String),
	}),
	Rpc.make("session.list", {
		payload: { projectId: FolderId },
		success: Schema.Array(Schema.String),
	}),
	Rpc.make("workspace.list", { success: Schema.Array(Schema.String) }),
	Rpc.make("workspace.streamChanges", {
		success: Schema.Array(Schema.String),
		stream: true,
	}),
	Rpc.make("session.get", {
		payload: { sessionId: SessionId },
		success: Schema.String,
	}),
	Rpc.make("attachments.read", {
		payload: { sessionId: SessionId, id: Schema.String },
		success: Schema.String,
	}),
	Rpc.make("session.events", {
		payload: { sessionId: SessionId },
		success: Schema.String,
		stream: true,
	}),
	Rpc.make("host.secret", { success: Schema.String }),
	Rpc.make("machines.checkout", { success: Schema.String }),
	Rpc.make("machines.billingPortal", { success: Schema.String }),
	Rpc.make("machines.entitlements", { success: Schema.String }),
).middleware(RpcAuthorization);
const chatCatalogStream = () =>
	Stream.concat(
		Stream.fromEffect(
			filterCatalog(["shared", "private"], (scope, id) =>
				scope.chats.has(ChatId.make(id)),
			),
		),
		Stream.never,
	).pipe(withCatalogChanges);
const fileScopeResult = () =>
	Effect.serviceOption(WorkspaceFileAccess).pipe(
		Effect.map((scope) =>
			scope._tag === "Some"
				? `${scope.value.folderId}:${scope.value.worktreeId ?? "main"}`
				: "host",
		),
	);
const handlers = Rpcs.toLayer({
	"machines.checkout": () => RequestWorkspace,
	"machines.billingPortal": () => RequestWorkspace,
	"machines.entitlements": () => RequestWorkspace,
	"connect.handshake": ({ protocolVersion }) =>
		Effect.succeed(WireWelcome.make({ protocolVersion })),
	"ping.ping": () =>
		Effect.succeed(
			PingResult.make({ message: "pong", receivedAt: new Date() }),
		),
	"fs.watchTree": () =>
		Stream.concat(Stream.fromEffect(fileScopeResult()), Stream.never),
	"fs.readFile": fileScopeResult,
	"fs.writeFile": fileScopeResult,
	"fs.tree": fileScopeResult,
	"fs.listPaths": fileScopeResult,
	"chat.streamChanges": chatCatalogStream,
	"session.streamChanges": chatCatalogStream,
	"chat.creation.stream": chatCatalogStream,
	"chat.creation.list": () =>
		filterCatalog(["shared", "private"], (scope, id) =>
			scope.chats.has(ChatId.make(id)),
		),
	"workspace.streamChanges": () =>
		Stream.concat(
			Stream.fromEffect(
				filterCatalog(["project", "private-project"], (scope, id) =>
					scope.projects.has(FolderId.make(id)),
				),
			),
			Stream.never,
		).pipe(withCatalogChanges),
	"chat.list": () =>
		filterCatalog(["shared", "private"], (scope, id) =>
			scope.chats.has(ChatId.make(id)),
		),
	"session.list": () =>
		filterCatalog(["shared", "private"], (scope, chatId) =>
			scope.chats.has(ChatId.make(chatId)),
		),
	"workspace.list": () =>
		filterCatalog(["project", "private-project"], (scope, id) =>
			scope.projects.has(FolderId.make(id)),
		),
	"session.get": () => Effect.succeed("transcript"),
	"attachments.read": () => Effect.succeed("attachment"),
	"session.events": () =>
		Stream.concat(Stream.succeed("connected"), Stream.never),
	"host.secret": () => Effect.succeed("host-only"),
});
const makeClient = RpcTest.makeClient(Rpcs, { flatten: true });

it("applies the authorization boundary to every public RPC", () => {
	for (const rpc of MemoizeRpcs.requests.values()) {
		expect(rpc.middlewares.has(RpcAuthorization), rpc._tag).toBe(true);
	}
});

it("enforces shared-workspace reads, denies other RPCs, and expires an active stream", async () => {
	let signedIn = true;
	let hostSubject = "owner";
	const auth = Layer.succeed(AuthService, {
		getSession: () =>
			Effect.sync(() =>
				signedIn
					? Schema.decodeUnknownSync(AuthState)({
							_tag: "SignedIn",
							session: {
								user: {
									id: hostSubject,
									email: "owner@example.com",
									firstName: null,
									lastName: null,
									profilePictureUrl: null,
								},
								organizationId: null,
								expiresAt: Date.now() + 60_000,
							},
						})
					: ({ _tag: "SignedOut" } as const),
			),
		signIn: () => Effect.succeed({ _tag: "SignedOut" } as const),
		signOut: () => Effect.void,
		sessionChanges: () => Stream.empty,
		getAccessToken: () => Effect.succeed("host-token"),
	});
	const sqlLayer = sqliteLayer({ filename: ":memory:", disableWAL: true });
	const database = sqlLayer.pipe(
		Layer.provideMerge(MigrationsLive.pipe(Layer.provide(sqlLayer))),
	);
	let guestRole: "viewer" | "owner" = "viewer";
	const roster = () =>
		OrganizationDetails.make({
			organization: Organization.make({
				id: "org",
				name: "Team",
				role: "admin",
			}),
			currentUserId: "owner",
			members: ["owner", "guest"].map((userId) =>
				OrganizationMember.make({
					id: `org-${userId}`,
					userId,
					email: `${userId}@example.com`,
					displayName: userId,
					role:
						userId === "owner" || guestRole === "owner" ? "admin" : "member",
					directoryManaged: false,
				}),
			),
			invitations: [],
		});
	const collaboration = CollaborationServiceLive.pipe(
		Layer.provide(database),
		Layer.provide(WorkspaceSharingAuthorityLive.pipe(Layer.provide(auth))),
		Layer.provide(
			Layer.succeed(OrganizationAuthority, {
				membership: (_, subject) =>
					Effect.succeed({
						role: subject === "owner" ? ("owner" as const) : guestRole,
						membershipId: `org-${subject}`,
					}),
			}),
		),
	);
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			database,
			collaboration,
			RpcAuthorizationLive.pipe(
				Layer.provide(database),
				Layer.provide(auth),
				Layer.provide(collaboration),
			),
		),
	);
	const call = <A, E>(
		identity: ConnectionIdentity["Service"],
		run: (client: Effect.Success<typeof makeClient>) => Effect.Effect<A, E>,
	) =>
		runtime.runPromise(
			Effect.scoped(Effect.flatMap(makeClient, run)).pipe(
				Effect.provide(handlers),
				Effect.provideService(ConnectionIdentity, identity),
			),
		);
	try {
		const { owner, guest } = await runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* CollaborationService;
				const sql = yield* SqlClient.SqlClient;
				const { team, actor: owner } = yield* service.synchronizeOrganization(
					roster(),
				);
				const guest = yield* service.resolveActor(team.id, "guest");
				const now = new Date().toISOString();
				yield* sql`INSERT INTO projects (id,path,name,created_at,updated_at) VALUES ('project','/tmp/rpc-test','Project',${now},${now})`;
				yield* sql`INSERT INTO chats (id,project_id,title,created_at,updated_at) VALUES ('shared','project','Shared',${now},${now}), ('private','project','Private',${now},${now})`;
				yield* sql`INSERT INTO sessions (id,project_id,chat_id,title,provider_id,model,status,created_at,updated_at) VALUES ('shared-session','project','shared','Shared','test','test','idle',${now},${now}), ('private-session','project','private','Private','test','test','idle',${now},${now})`;
				yield* service
					.shareWorkspace(owner, ChatId.make("shared"))
					.pipe(Effect.provideService(ConnectionIdentity, { kind: "local" }));
				yield* service.setWorkspaceGrant(
					owner,
					ChatId.make("shared"),
					guest.memberId,
					"viewer",
				);
				return { owner, guest };
			}),
		);
		let cloudPermission: "view" | "edit" = "view";
		let cloudRevoked = false;
		const cloudIdentity = {
			kind: "workspace" as const,
			subject: "cloud-member",
			membershipId: "membership-cloud-member",
			workspaceId: "cloud-workspace",
			chatId: ChatId.make("shared"),
			projectId: FolderId.make("project"),
			expiresAt: Date.now() + 60_000,
			authorize: Effect.suspend(() =>
				cloudRevoked
					? Effect.fail(new RpcAccessDeniedError({ code: "access-denied" }))
					: Effect.succeed(cloudPermission),
			),
		};
		signedIn = false;
		await expect(
			call(cloudIdentity, (client) =>
				client("fs.readFile", {
					folderId: FolderId.make("project"),
					path: "file.txt",
				}),
			),
		).resolves.toBe("project:main");
		await expect(
			call(cloudIdentity, (client) =>
				client("fs.writeFile", {
					folderId: FolderId.make("project"),
					path: "file.txt",
				}),
			),
		).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
		cloudPermission = "edit";
		await expect(
			call(cloudIdentity, (client) =>
				client("fs.writeFile", {
					folderId: FolderId.make("project"),
					path: "file.txt",
				}),
			),
		).resolves.toBe("project:main");
		for (const operation of [
			(client: Effect.Success<typeof makeClient>) =>
				client("host.secret", undefined),
			(client: Effect.Success<typeof makeClient>) =>
				client("session.get", { sessionId: SessionId.make("private-session") }),
			(client: Effect.Success<typeof makeClient>) =>
				client("fs.readFile", {
					folderId: FolderId.make("project"),
					path: "file.txt",
					worktreeId: WorktreeId.make("other"),
				}),
		])
			await expect(call(cloudIdentity, operation)).rejects.toMatchObject({
				_tag: "RpcAccessDeniedError",
			});
		await expect(
			call(cloudIdentity, (client) =>
				client("chat.list", { projectId: FolderId.make("project") }),
			),
		).resolves.toEqual(["shared"]);
		cloudRevoked = true;
		await expect(
			call(cloudIdentity, (client) =>
				client("fs.readFile", {
					folderId: FolderId.make("project"),
					path: "file.txt",
				}),
			),
		).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
		cloudRevoked = false;
		await expect(
			call({ ...cloudIdentity, expiresAt: Date.now() + 50 }, (client) =>
				Stream.runCollect(
					client("session.events", {
						sessionId: SessionId.make("shared-session"),
					}),
				),
			),
		).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
		signedIn = true;
		const guestIdentity = {
			kind: "account",
			subject: "guest",
			expiresAt: Date.now() + 60_000,
		} as const;
		const handshake = (client: Effect.Success<typeof makeClient>) =>
			client("connect.handshake", { protocolVersion: 5 });
		for (const operation of [
			(client: Effect.Success<typeof makeClient>) =>
				client("machines.checkout", undefined),
			(client: Effect.Success<typeof makeClient>) =>
				client("machines.billingPortal", undefined),
			(client: Effect.Success<typeof makeClient>) =>
				client("machines.entitlements", undefined),
		]) {
			await expect(
				call({ kind: "local" }, (client) =>
					operation(client).pipe(
						RpcClient.withHeaders({
							[WORKSPACE_SCOPE_HEADER]: "organization:org",
						}),
					),
				),
			).resolves.toBe("organization:org");
		}
		await expect(
			call({ kind: "local" }, (client) =>
				client("host.secret", undefined).pipe(
					RpcClient.withHeaders({
						[WORKSPACE_SCOPE_HEADER]: "organization:org",
					}),
				),
			),
		).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
		await expect(
			call({ kind: "local" }, (client) =>
				client("machines.checkout", undefined).pipe(
					RpcClient.withHeaders({ [WORKSPACE_SCOPE_HEADER]: "organization:" }),
				),
			),
		).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
		await expect(call(guestIdentity, handshake)).resolves.toMatchObject({
			protocolVersion: 5,
		});
		await expect(
			call(guestIdentity, (client) => client("ping.ping", {})),
		).resolves.toMatchObject({ message: "pong" });
		for (const identity of [
			{ ...guestIdentity, subject: "stranger" },
			{ ...guestIdentity, expiresAt: Date.now() - 1 },
		]) {
			await expect(call(identity, handshake)).rejects.toMatchObject({
				_tag: "RpcAccessDeniedError",
			});
		}
		for (const request of [
			{ folderId: FolderId.make("private-project") },
			{
				folderId: FolderId.make("project"),
				worktreeId: WorktreeId.make("private-worktree"),
			},
		]) {
			await expect(
				call(guestIdentity, (client) =>
					Stream.runCollect(
						client("fs.watchTree", request).pipe(Stream.take(1)),
					),
				),
			).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
		}
		await expect(
			call(guestIdentity, (client) =>
				client("fs.readFile", {
					folderId: FolderId.make("project"),
					path: "file.txt",
				}),
			),
		).resolves.toBe("project:main");
		for (const browse of [
			(client: Effect.Success<typeof makeClient>, worktreeId?: WorktreeId) =>
				client("fs.tree", { folderId: FolderId.make("project"), worktreeId }),
			(client: Effect.Success<typeof makeClient>, worktreeId?: WorktreeId) =>
				client("fs.listPaths", {
					folderId: FolderId.make("project"),
					worktreeId,
				}),
		]) {
			await expect(
				call(guestIdentity, (client) => browse(client)),
			).resolves.toBe("project:main");
			await expect(
				call(guestIdentity, (client) =>
					browse(client, WorktreeId.make("private-worktree")),
				),
			).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
			await expect(
				call({ ...guestIdentity, subject: "stranger" }, (client) =>
					browse(client),
				),
			).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
		}
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO worktrees (id,project_id,path,name,branch,base_branch,created_at)
				VALUES ('shared-worktree','project','/tmp/rpc-test-worktree','shared','shared','main',${new Date().toISOString()})`;
				yield* sql`UPDATE chats SET worktree_id = 'shared-worktree' WHERE id = 'shared'`;
			}),
		);
		await expect(
			call(guestIdentity, (client) =>
				client("fs.readFile", {
					folderId: FolderId.make("project"),
					path: "file.txt",
					worktreeId: WorktreeId.make("shared-worktree"),
				}),
			),
		).resolves.toBe("project:shared-worktree");
		// A private chat still uses the main checkout, but the guest has only
		// the isolated shared worktree: project visibility cannot widen it.
		await expect(
			call(guestIdentity, (client) =>
				client("fs.readFile", {
					folderId: FolderId.make("project"),
					path: "file.txt",
				}),
			),
		).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE chats SET worktree_id = NULL WHERE id = 'shared'`;
			}),
		);
		for (const request of [
			{ folderId: FolderId.make("private-project"), path: "file.txt" },
			{
				folderId: FolderId.make("project"),
				path: "file.txt",
				worktreeId: WorktreeId.make("private-worktree"),
			},
		]) {
			await expect(
				call(guestIdentity, (client) => client("fs.readFile", request)),
			).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
		}
		await expect(
			call({ ...guestIdentity, subject: "stranger" }, (client) =>
				client("fs.readFile", {
					folderId: FolderId.make("project"),
					path: "file.txt",
				}),
			),
		).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
		await expect(
			call({ ...guestIdentity, subject: "owner" }, (client) =>
				client("fs.readFile", {
					folderId: FolderId.make("project"),
					path: "file.txt",
				}),
			),
		).resolves.toBe("host");
		const startGuestStream = (fileWatch = false) => {
			let markReady = () => {};
			const ready = new Promise<void>((resolve) => {
				markReady = resolve;
			});
			const result = call(guestIdentity, (client) =>
				Stream.runForEach(
					fileWatch
						? client("fs.watchTree", { folderId: FolderId.make("project") })
						: client("session.events", {
								sessionId: SessionId.make("shared-session"),
							}),
					() => Effect.sync(markReady),
				),
			).then(
				() => null,
				(error: unknown) => error,
			);
			return { ready, result };
		};
		await expect(
			call(guestIdentity, (client) =>
				client("session.get", { sessionId: SessionId.make("shared-session") }),
			),
		).resolves.toBe("transcript");
		for (const list of [
			(client: Effect.Success<typeof makeClient>) =>
				client("chat.list", { projectId: FolderId.make("project") }),
			(client: Effect.Success<typeof makeClient>) =>
				client("session.list", { projectId: FolderId.make("project") }),
		]) {
			await expect(
				call(guestIdentity, (client) => list(client)),
			).resolves.toEqual(["shared"]);
			await expect(
				call({ ...guestIdentity, subject: "owner" }, (client) => list(client)),
			).resolves.toEqual(["shared", "private"]);
			await expect(
				call({ ...guestIdentity, subject: "stranger" }, (client) =>
					list(client),
				),
			).resolves.toEqual([]);
		}
		await expect(
			call(guestIdentity, (client) => client("workspace.list", undefined)),
		).resolves.toEqual(["project"]);
		const frames: ReadonlyArray<string>[] = [];
		for (const read of [
			(client: Effect.Success<typeof makeClient>) =>
				client("chat.streamChanges", { projectId: FolderId.make("project") }),
			(client: Effect.Success<typeof makeClient>) =>
				client("session.streamChanges", {
					projectId: FolderId.make("project"),
				}),
			(client: Effect.Success<typeof makeClient>) =>
				client("chat.creation.stream", { projectId: FolderId.make("project") }),
		]) {
			await expect(
				call(guestIdentity, (client) =>
					read(client).pipe(Stream.take(1), Stream.runCollect),
				),
			).resolves.toEqual([["shared"]]);
			await expect(
				call({ ...guestIdentity, subject: "stranger" }, (client) =>
					read(client).pipe(Stream.take(1), Stream.runCollect),
				),
			).resolves.toEqual([[]]);
		}
		await expect(
			call(guestIdentity, (client) =>
				client("chat.creation.list", { projectId: FolderId.make("project") }),
			),
		).resolves.toEqual(["shared"]);
		const watching = call(guestIdentity, (client) =>
			client("workspace.streamChanges", undefined).pipe(
				Stream.take(3),
				Stream.runForEach((frame) =>
					Effect.sync(() => {
						frames.push(frame);
					}),
				),
			),
		);
		await expect.poll(() => frames).toEqual([["project"]]);
		const service = await runtime.runPromise(CollaborationService);
		const originalLookup = service.visibleWorkspaces;
		const entered = await Effect.runPromise(Deferred.make<void>());
		const release = await Effect.runPromise(Deferred.make<void>());
		const rechecked = await Effect.runPromise(Deferred.make<void>());
		const lookup = vi
			.spyOn(service, "visibleWorkspaces")
			.mockImplementationOnce((subject) =>
				originalLookup(subject).pipe(
					Effect.flatMap((result) =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
							Effect.as(result),
						),
					),
				),
			)
			.mockImplementationOnce((subject) =>
				originalLookup(subject).pipe(
					Effect.tap(() => Deferred.succeed(rechecked, undefined)),
				),
			);
		await runtime.runPromise(
			service
				.shareWorkspace(owner, ChatId.make("shared"))
				.pipe(Effect.provideService(ConnectionIdentity, { kind: "local" })),
		);
		await Effect.runPromise(Deferred.await(entered));
		await runtime.runPromise(
			Effect.flatMap(CollaborationService, (service) =>
				service.removeWorkspaceGrant(
					owner,
					ChatId.make("shared"),
					guest.memberId,
				),
			),
		);
		await expect.poll(() => frames).toEqual([["project"], []]);
		await Effect.runPromise(Deferred.succeed(release, undefined));
		await Effect.runPromise(Deferred.await(rechecked));
		expect(frames).toEqual([["project"], []]);
		lookup.mockRestore();
		await expect(
			call(guestIdentity, (client) =>
				client("fs.readFile", {
					folderId: FolderId.make("project"),
					path: "file.txt",
				}),
			),
		).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
		await runtime.runPromise(
			Effect.flatMap(CollaborationService, (service) =>
				service.setWorkspaceGrant(
					owner,
					ChatId.make("shared"),
					guest.memberId,
					"viewer",
				),
			),
		);
		await watching;
		expect(frames).toEqual([["project"], [], ["project"]]);
		let markCatalogReady = () => {};
		const catalogReady = new Promise<void>((resolve) => {
			markCatalogReady = resolve;
		});
		const switchedAccount = call(guestIdentity, (client) =>
			client("workspace.streamChanges", undefined).pipe(
				Stream.runForEach(() => Effect.sync(markCatalogReady)),
			),
		).then(
			() => null,
			(error: unknown) => error,
		);
		await catalogReady;
		hostSubject = "guest";
		await runtime.runPromise(
			service
				.shareWorkspace(owner, ChatId.make("shared"))
				.pipe(Effect.provideService(ConnectionIdentity, { kind: "local" })),
		);
		await expect(switchedAccount).resolves.toMatchObject({
			_tag: "RpcAccessDeniedError",
			code: "access-denied",
		});
		hostSubject = "owner";
		await expect(
			call(guestIdentity, (client) =>
				client("attachments.read", {
					sessionId: SessionId.make("shared-session"),
					id: "attachment_1",
				}),
			),
		).resolves.toBe("attachment");
		await expect(
			call(guestIdentity, (client) =>
				client("attachments.read", {
					sessionId: SessionId.make("private-session"),
					id: "attachment_1",
				}),
			),
		).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
		await expect(
			call(guestIdentity, (client) =>
				client("session.get", { sessionId: SessionId.make("private-session") }),
			),
		).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
		await expect(
			call(guestIdentity, (client) => client("host.secret", undefined)),
		).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
		await expect(
			call({ ...guestIdentity, subject: "owner" }, (client) =>
				client("host.secret", undefined),
			),
		).resolves.toBe("host-only");
		await expect(
			call({ ...guestIdentity, expiresAt: Date.now() + 100 }, (client) =>
				Stream.runDrain(
					client("session.events", {
						sessionId: SessionId.make("shared-session"),
					}),
				),
			),
		).rejects.toMatchObject({
			_tag: "RpcAccessDeniedError",
			code: "credential-expired",
		});
		const grantedStream = startGuestStream();
		const grantedFileStream = startGuestStream(true);
		await grantedStream.ready;
		await grantedFileStream.ready;
		await runtime.runPromise(
			Effect.flatMap(CollaborationService, (service) =>
				service.removeWorkspaceGrant(
					owner,
					ChatId.make("shared"),
					guest.memberId,
				),
			),
		);
		await expect(grantedStream.result).resolves.toMatchObject({
			_tag: "RpcAccessDeniedError",
			code: "access-denied",
		});
		await expect(grantedFileStream.result).resolves.toMatchObject({
			_tag: "RpcAccessDeniedError",
			code: "access-denied",
		});
		await expect(
			call(guestIdentity, (client) => client("workspace.list", undefined)),
		).resolves.toEqual([]);
		await expect(
			call(guestIdentity, (client) =>
				client("session.get", { sessionId: SessionId.make("shared-session") }),
			),
		).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
		await runtime.runPromise(
			Effect.flatMap(CollaborationService, (service) =>
				service.setWorkspaceGrant(
					owner,
					ChatId.make("shared"),
					guest.memberId,
					"viewer",
				),
			),
		);
		const sharedStream = startGuestStream();
		await sharedStream.ready;
		await runtime.runPromise(
			Effect.flatMap(CollaborationService, (service) =>
				service.unshareWorkspace(owner, ChatId.make("shared")),
			).pipe(Effect.provideService(ConnectionIdentity, { kind: "local" })),
		);
		await expect(sharedStream.result).resolves.toMatchObject({
			_tag: "RpcAccessDeniedError",
			code: "access-denied",
		});
		await expect(call(guestIdentity, handshake)).rejects.toMatchObject({
			_tag: "RpcAccessDeniedError",
			code: "access-denied",
		});
		await runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* CollaborationService;
				yield* service
					.shareWorkspace(owner, ChatId.make("shared"))
					.pipe(Effect.provideService(ConnectionIdentity, { kind: "local" }));
				guestRole = "owner";
				yield* service.synchronizeOrganization(roster());
			}),
		);
		const organizationOwnerStream = startGuestStream();
		await organizationOwnerStream.ready;
		let ownerStreamEnded = false;
		void organizationOwnerStream.result.then(() => {
			ownerStreamEnded = true;
		});
		await runtime.runPromise(
			Effect.flatMap(CollaborationService, (service) =>
				service.removeWorkspaceGrant(
					owner,
					ChatId.make("shared"),
					guest.memberId,
				),
			),
		);
		expect(ownerStreamEnded).toBe(false);
		await runtime.runPromise(
			Effect.flatMap(CollaborationService, (service) =>
				service.applyOrganizationMembershipRestriction({
					organizationId: "org",
					memberId: "org-guest",
					change: "removed",
				}),
			),
		);
		await expect(organizationOwnerStream.result).resolves.toMatchObject({
			_tag: "RpcAccessDeniedError",
			code: "access-denied",
		});
		signedIn = false;
		await expect(
			call({ ...guestIdentity, subject: "owner" }, (client) =>
				client("host.secret", undefined),
			),
		).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
		await expect(
			call({ kind: "local" }, (client) => client("host.secret", undefined)),
		).resolves.toBe("host-only");
	} finally {
		await runtime.dispose();
	}
});
