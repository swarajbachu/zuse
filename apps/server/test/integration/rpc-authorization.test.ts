import {
	AuthState,
	ChatId,
	ConnectHandshakeRpc,
	FolderId,
	MemoizeRpcs,
	PingResult,
	PingRpc,
	RpcAccessDeniedError,
	RpcAuthorization,
	SessionId,
	WireWelcome,
	WorktreeId,
} from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { Rpc, RpcGroup, RpcTest } from "effect/unstable/rpc";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { AuthService } from "../../src/auth/services/auth-service.ts";
import { filterCatalog } from "../../src/collaboration/services/catalog-visibility.ts";
import { WorkspaceFileAccess } from "../../src/collaboration/services/workspace-file-access.ts";
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
	Rpc.make("machines.prepaidBalance", { success: Schema.String }),
	Rpc.make("machines.prepaidCheckout", { success: Schema.String }),
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
	);
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
	"machines.prepaidBalance": () => RequestWorkspace,
	"machines.prepaidCheckout": () => RequestWorkspace,
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
		),
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
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			database,
			RpcAuthorizationLive.pipe(Layer.provide(database), Layer.provide(auth)),
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
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const now = new Date().toISOString();
				yield* sql`INSERT INTO projects (id,path,name,created_at,updated_at) VALUES ('project','/tmp/rpc-test','Project',${now},${now})`;
				yield* sql`INSERT INTO chats (id,project_id,title,created_at,updated_at) VALUES ('shared','project','Shared',${now},${now}), ('private','project','Private',${now},${now})`;
				yield* sql`INSERT INTO sessions (id,project_id,chat_id,title,provider_id,model,status,created_at,updated_at) VALUES ('shared-session','project','shared','Shared','test','test','idle',${now},${now}), ('private-session','project','private','Private','test','test','idle',${now},${now})`;
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
				client("machines.prepaidBalance", undefined),
			(client: Effect.Success<typeof makeClient>) =>
				client("machines.prepaidCheckout", undefined),
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
		const ownerIdentity = {
			kind: "account" as const,
			subject: "owner",
			expiresAt: Date.now() + 60_000,
		};
		await expect(
			call(ownerIdentity, (client) => client("host.secret", undefined)),
		).resolves.toBe("host-only");
		await expect(
			call({ ...ownerIdentity, subject: "guest" }, (client) =>
				client("host.secret", undefined),
			),
		).rejects.toMatchObject({ code: "access-denied" });
		await expect(
			call({ ...ownerIdentity, expiresAt: Date.now() + 50 }, (client) =>
				Stream.runCollect(
					client("session.events", {
						sessionId: SessionId.make("shared-session"),
					}),
				),
			),
		).rejects.toMatchObject({ code: "credential-expired" });
		hostSubject = "different-owner";
		await expect(
			call(ownerIdentity, (client) => client("host.secret", undefined)),
		).rejects.toMatchObject({ code: "access-denied" });
	} finally {
		await runtime.dispose();
	}
});
