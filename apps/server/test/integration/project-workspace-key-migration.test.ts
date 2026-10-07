import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { Migration0063ProjectWorkspaceKey } from "../../src/persistence/migrations/0063_project_workspace_key.ts";

it("assigns existing projects to Personal", async () => {
	const rows = await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL)`;
			yield* sql`INSERT INTO projects VALUES ('existing', '/repos/existing')`;
			yield* Migration0063ProjectWorkspaceKey;
			yield* sql`INSERT INTO projects (id, path) VALUES ('new', '/repos/new')`;
			return yield* sql`SELECT id, workspace_key FROM projects ORDER BY id`;
		}).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
	expect(rows).toEqual([
		{ id: "existing", workspace_key: "personal" },
		{ id: "new", workspace_key: "personal" },
	]);
});
