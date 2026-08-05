import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

const STAGING_DATABASE_HOSTS = new Set([
	"ep-wild-feather-a10yvwmg.ap-southeast-1.aws.neon.tech",
	"ep-wild-feather-a10yvwmg-pooler.ap-southeast-1.aws.neon.tech",
]);
const STAGING_DATABASE_NAME = "frankdb";

if (existsSync(".env")) loadEnvFile(".env");

const target = process.argv[2];
if (target !== "staging") {
	console.error("Only the staging database has a configured migration target.");
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
		"Refusing to migrate: DATABASE_URL is not the staging Neon database.",
	);
	process.exit(1);
}

const result = spawnSync("bunx", ["drizzle-kit", "migrate"], {
	stdio: "inherit",
});

if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
