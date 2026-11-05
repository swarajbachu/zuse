import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy } from "wrangler";

const [environment, apply, startAfter = ""] = process.argv.slice(2);
if (!["staging", "production"].includes(environment) || apply !== "--apply") {
	throw new Error(
		"Usage: node infra/api/scripts/migrate-automation-scheduler.mjs staging|production --apply [afterAccountId]",
	);
}
const directory = await mkdtemp(join(tmpdir(), "zuse-automation-migration-"));
let platform;
try {
	const configPath = join(directory, "wrangler.json");
	await writeFile(
		configPath,
		JSON.stringify({
			name: "zuse-automation-migration-client",
			compatibility_date: "2026-06-01",
			services: [
				{
					binding: "MIGRATION",
					service:
						environment === "production" ? "zuse-relay" : "zuse-relay-staging",
					entrypoint: "AutomationMigration",
					remote: true,
				},
			],
		}),
	);
	platform = await getPlatformProxy({
		configPath,
		persist: false,
		remoteBindings: true,
	});
	let cursor = startAfter;
	let migrated = 0;
	for (;;) {
		const page = await platform.env.MIGRATION.migrate(cursor, 25);
		migrated += page.accountIds.length;
		console.log(JSON.stringify({ environment, migrated, next: page.next }));
		if (page.next === null) break;
		if (page.next <= cursor)
			throw new Error("migration_cursor_did_not_advance");
		cursor = page.next;
	}
} finally {
	await platform?.dispose();
	await rm(directory, { recursive: true, force: true });
}
