/** Run from each release checkout against the same isolated directory. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppPaths } from "../src/app-paths.ts";
import { ConfigStoreServiceLive } from "../src/config-store/layers/config-store-service.ts";
import { ConfigStoreService } from "../src/config-store/services/config-store-service.ts";
import { MigrationsLive } from "../src/persistence/migrations.ts";

const [directoryArg, stage] = process.argv.slice(2);
assert(
	directoryArg &&
		["stable-create", "preview", "stable-return"].includes(stage ?? ""),
	"Expected an isolated directory and probe stage",
);
const directory = resolve(directoryArg);
mkdirSync(directory, { recursive: true });
process.env.ZUSE_CONFIG_DIR = join(directory, "config");
delete process.env.ZUSE_CONFIG_PROFILE;
delete process.env.ZUSE_DEV_CONFIG;
delete process.env.VITE_DEV_SERVER_URL;
const sqlite = sqliteLayer({ filename: join(directory, "zuse.sqlite") });
const config = ConfigStoreServiceLive.pipe(
	Layer.provide(Layer.succeed(AppPaths, { userData: directory })),
	Layer.provide(NodeServices.layer),
);
const runtime = ManagedRuntime.make(
	Layer.mergeAll(sqlite, MigrationsLive.pipe(Layer.provide(sqlite)), config),
);
try {
	await runtime.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const settings = yield* ConfigStoreService;
			const now = "2026-01-01T00:00:00.000Z";
			if (stage === "stable-create") {
				yield* sql`INSERT INTO projects (id, path, name, created_at, updated_at) VALUES ('compat-project', '/tmp/compat-project', 'Compatibility', ${now}, ${now})`;
				yield* settings.updateSettings({
					appearanceMode: "dark",
					onboardingCompleted: true,
				});
			} else {
				const previous = stage === "preview" ? "stable-create" : "preview";
				const chats =
					yield* sql`SELECT title FROM chats WHERE id = ${`compat-${previous}`}`;
				assert.equal(chats[0]?.title, previous);
				const sessions =
					yield* sql`SELECT title FROM sessions WHERE id = ${`compat-${previous}`}`;
				assert.equal(sessions[0]?.title, previous);
				const saved = yield* settings.getSettings();
				assert.equal(
					saved.appearanceMode,
					stage === "preview" ? "dark" : "light",
				);
				assert.equal(saved.onboardingCompleted, true);
				yield* settings.updateSettings({
					appearanceMode: stage === "preview" ? "light" : "dark",
				});
				yield* sql`UPDATE sessions SET title = 'Read and modified' WHERE id = ${`compat-${previous}`}`;
			}
			const id = `compat-${stage}`;
			yield* sql`INSERT INTO chats (id, project_id, title, created_at, updated_at) VALUES (${id}, 'compat-project', ${stage}, ${now}, ${now})`;
			yield* sql`INSERT INTO sessions (id, project_id, title, provider_id, model, status, chat_id, created_at, updated_at) VALUES (${id}, 'compat-project', ${stage}, 'codex', 'gpt-5', 'idle', ${id}, ${now}, ${now})`;
			yield* sql`UPDATE chats SET active_session_id = ${id} WHERE id = ${id}`;
			assert.equal((yield* sql`PRAGMA quick_check`)[0]?.quick_check, "ok");
			assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
		}),
	);
	console.log(`Desktop data compatibility: ${stage} passed`);
} finally {
	await runtime.dispose();
}
