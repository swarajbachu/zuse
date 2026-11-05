import { ChatId, FolderId, RpcAccessDeniedError } from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { authorizeWorkspaceRpc } from "../../src/lan-auth/layers/workspace-rpc-authorization.ts";
import type { WorkspaceCredentialIdentity } from "../../src/lan-auth/services/connection-identity.ts";

it("allows only freshly authorized owner administrators to access cloud automations", async () => {
	const runtime = ManagedRuntime.make(
		sqliteLayer({ filename: ":memory:", disableWAL: true }),
	);
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`CREATE TABLE chats (id TEXT, project_id TEXT,worktree_id TEXT)`;
				yield* sql`INSERT INTO chats VALUES ('chat','project',NULL)`;
			}),
		);
		const shared: WorkspaceCredentialIdentity = {
			kind: "workspace",
			subject: "member",
			membershipId: "member-1",
			workspaceId: "workspace",
			chatId: ChatId.make("chat"),
			projectId: FolderId.make("project"),
			expiresAt: Date.now() + 60_000,
			authorize: Effect.succeed("edit"),
		};
		for (const tag of [
			"automation.list",
			"automation.get",
			"automation.save",
			"automation.run",
			"automation.dispatch",
		]) {
			await expect(
				runtime.runPromise(
					authorizeWorkspaceRpc(Effect.succeed("secret"), shared, tag, {
						automationAdmin: true,
					}),
				),
			).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
		}
		let administrator = true;
		const owner: WorkspaceCredentialIdentity = {
			...shared,
			authorizeAutomations: Effect.suspend(() =>
				administrator
					? Effect.void
					: Effect.fail(new RpcAccessDeniedError({ code: "access-denied" })),
			),
		};
		expect(
			await runtime.runPromise(
				authorizeWorkspaceRpc(
					Effect.succeed("ok"),
					owner,
					"automation.save",
					{},
				),
			),
		).toBe("ok");
		administrator = false;
		await expect(
			runtime.runPromise(
				authorizeWorkspaceRpc(
					Effect.succeed("secret"),
					owner,
					"automation.get",
					{},
				),
			),
		).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
		await expect(
			runtime.runPromise(
				authorizeWorkspaceRpc(
					Effect.succeed("secret"),
					{ ...owner, expiresAt: 0 },
					"automation.get",
					{},
				),
			),
		).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
	} finally {
		await runtime.dispose();
	}
});
