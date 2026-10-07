#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runAgentCli } from "./agent-cli.ts";

const args = process.argv.slice(2);
// Images already install the service-management CLI here. Keep those commands
// available when the runtime's newer orchestration CLI takes precedence on PATH.
const serviceCli = "/usr/local/bin/zuse";
if (
	args[0] === "serve" &&
	existsSync(serviceCli) &&
	realpathSync(serviceCli) !== realpathSync(fileURLToPath(import.meta.url))
) {
	const child = spawnSync(serviceCli, args, { stdio: "inherit" });
	if (child.error) console.error(child.error.message);
	process.exitCode = child.status ?? 1;
} else {
	await runAgentCli(
		args.length === 0 || args[0] === "--help" || args[0] === "-h"
			? ["help"]
			: args,
	);
}
