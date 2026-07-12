import { FolderId, SessionId } from "@zuse/contracts";
import { hasProductionDatabase } from "@zuse/testkit";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { verifyBackfillDatabase } from "../../../../apps/server/src/persistence/backfill-verifier.ts";
import { initializeSystemRepository } from "../../src/conversation-fixture.ts";
import {
	createLegacyDatabase,
	legacyFixture,
} from "../../src/legacy-database.ts";
import { withSystemTest } from "../../src/system-scope.ts";

describe("headless server production composition", () => {
	it("boots on an operating-system assigned port and serves the real transport", async () => {
		await withSystemTest("zuse-system-startup-", async (scope) => {
			const server = await scope.server();
			const response = await fetch(`http://127.0.0.1:${server.port}/`);
			expect(response.status).toBe(426);
			expect(await response.json()).toEqual({
				error: "wire_protocol_mismatch",
				expectedVersion: expect.any(Number),
			});
			expect(hasProductionDatabase(server)).toBe(true);
		});
	}, 30_000);

	it("rejects unauthenticated WebSocket upgrades in protected mode", async () => {
		await withSystemTest("zuse-system-auth-", async (scope) => {
			const server = await scope.server({ host: "0.0.0.0" });
			const response = await fetch(
				`http://127.0.0.1:${server.port}/?wireVersion=1`,
			);
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({ error: "unauthorized" });
		});
	}, 30_000);

	it("starts from a representative v29 database and verifies byte-equivalent projections", async () => {
		await withSystemTest("zuse-system-migrated-db-", async (scope) => {
			const repository = scope.path("repository");
			initializeSystemRepository(repository);
			const database = scope.path("user-data", "zuse.sqlite");
			await createLegacyDatabase(database, repository);

			const server = await scope.server();
			const session = await scope.rpc(server.endpoint);
			const chats = await Effect.runPromise(
				session.client["chat.list"]({
					projectId: FolderId.make(legacyFixture.projectId),
					includeArchived: true,
				}),
			);
			expect(chats.map((chat) => chat.title)).toContain(legacyFixture.title);
			const messages = await Effect.runPromise(
				session.client["messages.list"]({
					sessionId: SessionId.make(legacyFixture.sessionId),
				}),
			);
			expect(
				messages.some(
					(message) =>
						message.content._tag === "user" &&
						message.content.text === legacyFixture.message,
				),
			).toBe(true);

			await session.dispose();
			await server.stop();
			await expect(verifyBackfillDatabase(database)).resolves.toBeUndefined();
		});
	}, 45_000);
});
