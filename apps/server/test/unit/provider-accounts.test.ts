import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";
import { Migration0064ProviderAccounts } from "../../src/persistence/migrations/0064_provider_accounts.ts";
import {
	makeProviderAccounts,
	ProviderAccounts,
} from "../../src/provider/services/provider-accounts.ts";
import { loadSessionUsageWindows } from "../../src/usage/limits/session-events.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
const run = async <A, E>(
	test: (root: string) => Effect.Effect<A, E, SqlClient.SqlClient>,
) => {
	const root = await mkdtemp(join(tmpdir(), "zuse-accounts-"));
	roots.push(root);
	return Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`PRAGMA foreign_keys=ON`;
			yield* sql`CREATE TABLE sessions(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,forked_from_session_id TEXT)`;
			yield* sql`INSERT INTO sessions(id,provider_id) VALUES('legacy','claude'),('legacy-codex','codex')`;
			yield* Migration0064ProviderAccounts;
			return yield* test(root);
		}).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
};

describe("native provider accounts", () => {
	it("filters usage by the originating account even after a session changes provider", async () => {
		await run((root) =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const accounts = yield* makeProviderAccounts(root);
				const work = yield* accounts.save("codex", "Work");
				const personal = yield* accounts.save("codex", "Personal");
				yield* sql`CREATE TABLE messages(session_id TEXT,kind TEXT,content_json TEXT,created_at TEXT)`;
				yield* sql`INSERT INTO sessions(id,provider_id) VALUES('work-usage','codex'),('personal-usage','codex')`;
				yield* accounts.preferred("codex", work.id);
				yield* accounts.resolve("codex", "work-usage", false);
				yield* accounts.preferred("codex", personal.id);
				yield* accounts.resolve("codex", "personal-usage", false);
				yield* accounts.preferred("codex", work.id);
				yield* sql`UPDATE sessions SET provider_id='claude' WHERE id='work-usage'`;
				for (const [session, usedPercent, day] of [
					["work-usage", 10, "01"],
					["personal-usage", 80, "02"],
					["legacy-codex", 30, "03"],
				] as const) {
					const content = JSON.stringify({
						providerId: "codex",
						id: "session",
						label: "Session",
						scope: "session",
						resetsAt: null,
						windowMinutes: null,
						usedPercent,
					});
					yield* sql`INSERT INTO messages VALUES(${session},'usage_limit',${content},${`2026-10-${day}T12:00:00Z`})`;
				}
				yield* sql`INSERT INTO messages VALUES('work-usage','usage_limit','invalid-json','2026-10-04T12:00:00Z')`;
				const windows = yield* loadSessionUsageWindows.pipe(
					Effect.provideService(ProviderAccounts, accounts),
				);
				expect(windows).toHaveLength(1);
				expect(windows[0]?.window.usedPercent).toBe(10);
				yield* accounts.preferred("codex", null);
				const defaults = yield* loadSessionUsageWindows.pipe(
					Effect.provideService(ProviderAccounts, accounts),
				);
				expect(defaults[0]?.window.usedPercent).toBe(30);
			}),
		);
	});
	it("isolates homes and pins default and named chats across preference changes and restart", async () => {
		await run((root) =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const accounts = yield* makeProviderAccounts(root);
				const work = yield* accounts.save("claude", "Work");
				const personal = yield* accounts.save("claude", "Personal");
				yield* accounts.preferred("claude", work.id);
				expect(yield* accounts.resolve("claude", "legacy", false)).toBeNull();
				yield* sql`INSERT INTO sessions(id,provider_id) VALUES('work-chat','claude'),('personal-chat','claude')`;
				const first = yield* accounts.resolve("claude", "work-chat", false);
				yield* accounts.preferred("claude", personal.id);
				const restarted = yield* makeProviderAccounts(root);
				expect(yield* restarted.resolve("claude", "work-chat", true)).toEqual(
					first,
				);
				expect(
					(yield* restarted.resolve("claude", "personal-chat", false))?.id,
				).toBe(personal.id);
				expect(first?.home).toBe(
					join(root, "provider-accounts", "claude", work.id),
				);
				expect(
					(yield* Effect.promise(() => stat(first?.home ?? ""))).mode & 0o777,
				).toBe(0o700);
			}),
		);
	});
	it("inherits the source account for native forks and refuses removed accounts", async () => {
		await run((root) =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const accounts = yield* makeProviderAccounts(root);
				const account = yield* accounts.save("codex", "Work");
				yield* accounts.preferred("codex", account.id);
				yield* sql`INSERT INTO sessions(id,provider_id) VALUES('source','codex')`;
				yield* accounts.resolve("codex", "source", false);
				yield* accounts.preferred("codex", null);
				yield* sql`INSERT INTO sessions(id,provider_id,forked_from_session_id) VALUES('fork','codex','source')`;
				expect((yield* accounts.resolve("codex", "fork", true))?.id).toBe(
					account.id,
				);
				yield* accounts.remove("codex", account.id);
				const error = yield* accounts
					.resolve("codex", "fork", true)
					.pipe(Effect.flip);
				expect(error.message).toContain("removed");
				expect(yield* accounts.selected("codex")).toBeNull();
			}),
		);
	});
	it("keeps preferences provider-specific and rolls back invalid selections", async () => {
		await run((root) =>
			Effect.gen(function* () {
				const accounts = yield* makeProviderAccounts(root);
				const claude = yield* accounts.save("claude", " Work ");
				const codex = yield* accounts.save("codex", "Work");
				yield* accounts.preferred("claude", claude.id);
				yield* accounts.preferred("codex", codex.id);
				yield* accounts.preferred("claude", codex.id).pipe(Effect.flip);
				expect((yield* accounts.list("claude")).accounts).toEqual([
					{ ...claude, name: "Work", preferred: true },
				]);
				yield* accounts.save("claude", "Renamed", claude.id);
				expect((yield* accounts.selected("claude"))?.id).toBe(claude.id);
			}),
		);
	});
	it("does not enable host profiles on a cloud runtime or change its credential resolution", async () => {
		await run((root) =>
			Effect.gen(function* () {
				const accounts = yield* makeProviderAccounts(root, false);
				expect(yield* accounts.list("codex")).toEqual({
					available: false,
					accounts: [],
				});
				expect(
					yield* accounts.resolve("codex", "legacy-codex", true),
				).toBeNull();
				expect(
					(yield* accounts.save("codex", "Work").pipe(Effect.flip)).message,
				).toContain("local and SSH");
			}),
		);
	});
	it("cleans session affinity on deletion without deleting provider transcript homes", async () => {
		await run(() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`DELETE FROM sessions WHERE id='legacy'`;
				expect(
					yield* sql`SELECT * FROM session_provider_accounts WHERE session_id='legacy'`,
				).toEqual([]);
			}),
		);
	});
});
