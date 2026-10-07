#!/usr/bin/env node

import { installSnapshot } from "./snapshot.ts";

async function main() {
	const args = process.argv.slice(2);
	if (args[0] === "snapshot") {
		if (args[1] !== "install")
			throw new Error(
				"Usage: npx zusehq snapshot install [--user development-user]",
			);
		return installSnapshot(args.slice(2));
	}
	const { runServeCli } = await import("@zusehq/serve/cli");
	return runServeCli(args, process.env);
}

main().catch((cause) => {
	console.error(cause instanceof Error ? cause.message : String(cause));
	process.exitCode = 1;
});
