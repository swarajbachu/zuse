import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";

const STAGING_DATABASE_HOSTS = new Set(["db.yzawvredrbpcwbzdnxsu.supabase.co"]);
const STAGING_DATABASE_NAME = "postgres";
const PRODUCTION_CONFIRMATION = "migrate-api.zuse.sh";
const productionDatabase = JSON.parse(
	readFileSync(new URL("../production-database.json", import.meta.url), "utf8"),
);

if (existsSync(".env")) loadEnvFile(".env");

const target = process.argv[2];
if (target !== "staging" && target !== "production") {
	console.error("Migration target must be staging or production.");
	process.exit(1);
}

const rawDatabaseUrl = process.env.DATABASE_URL;
if (rawDatabaseUrl === undefined || rawDatabaseUrl === "") {
	console.error("DATABASE_URL is required.");
	process.exit(1);
}

let databaseUrl;
try {
	databaseUrl = new URL(rawDatabaseUrl);
} catch {
	console.error("DATABASE_URL must be a valid Postgres URL.");
	process.exit(1);
}

const databaseName = decodeURIComponent(
	databaseUrl.pathname.replace(/^\//, ""),
);
const isStagingDatabase =
	STAGING_DATABASE_HOSTS.has(databaseUrl.hostname) &&
	databaseName === STAGING_DATABASE_NAME;

if (target === "staging" && !isStagingDatabase) {
	console.error(
		"Refusing to migrate: DATABASE_URL is not the approved staging database.",
	);
	process.exit(1);
}

if (target === "production") {
	if (
		process.env.ZUSE_CONFIRM_PRODUCTION_DATABASE_MIGRATION !==
		PRODUCTION_CONFIRMATION
	) {
		console.error(
			`Refusing to migrate production. Set ZUSE_CONFIRM_PRODUCTION_DATABASE_MIGRATION=${PRODUCTION_CONFIRMATION}.`,
		);
		process.exit(1);
	}
	if (isStagingDatabase) {
		console.error("Refusing to use a known staging database for production.");
		process.exit(1);
	}
	if (
		productionDatabase.host.startsWith("REPLACE_WITH_") ||
		productionDatabase.name.startsWith("REPLACE_WITH_")
	) {
		console.error(
			"The approved production database identity has not been configured.",
		);
		process.exit(1);
	}
	if (
		databaseUrl.hostname !== productionDatabase.host ||
		databaseName !== productionDatabase.name
	) {
		console.error(
			"Refusing to migrate: DATABASE_URL does not match the approved production database identity.",
		);
		process.exit(1);
	}
}

const result = spawnSync("bunx", ["drizzle-kit", "migrate"], {
	stdio: "inherit",
});

if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
