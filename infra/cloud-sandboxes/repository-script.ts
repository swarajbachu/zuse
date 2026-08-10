import { existsSync } from "node:fs";

const kind = Bun.argv[2];
if (kind !== "setup" && kind !== "archive" && kind !== "environment")
	process.exit(64);

let script = "";
if (existsSync(".zuse/settings.toml")) {
	const settings = Bun.TOML.parse(
		await Bun.file(".zuse/settings.toml").text(),
	) as {
		readonly scripts?: { readonly setup?: unknown; readonly archive?: unknown };
		readonly cloud?: { readonly environment_variables?: unknown };
	};
	if (kind === "environment") {
		const environment = settings.cloud?.environment_variables;
		if (typeof environment === "object" && environment !== null) {
			for (const [key, value] of Object.entries(environment)) {
				if (/^[A-Z_][A-Z0-9_]*$/u.test(key) && typeof value === "string")
					process.stdout.write(`${key}\0${value}\0`);
			}
		}
		process.exit(0);
	}
	const value = settings.scripts?.[kind];
	if (typeof value === "string") script = value;
} else if (existsSync(".zuse/settings.json")) {
	const settings = (await Bun.file(".zuse/settings.json").json()) as {
		readonly setupScript?: unknown;
		readonly archiveCleanupScript?: unknown;
		readonly cloudEnvironmentVariables?: unknown;
	};
	if (kind === "environment") {
		const environment = settings.cloudEnvironmentVariables;
		if (typeof environment === "object" && environment !== null) {
			for (const [key, value] of Object.entries(environment)) {
				if (/^[A-Z_][A-Z0-9_]*$/u.test(key) && typeof value === "string")
					process.stdout.write(`${key}\0${value}\0`);
			}
		}
		process.exit(0);
	}
	const value =
		kind === "setup" ? settings.setupScript : settings.archiveCleanupScript;
	if (typeof value === "string") script = value;
}

process.stdout.write(script.trim());
