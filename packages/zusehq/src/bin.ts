#!/usr/bin/env node

import { runServeCli } from "@zusehq/serve/cli";

runServeCli(process.argv.slice(2), process.env).catch((cause) => {
	console.error(cause instanceof Error ? cause.message : String(cause));
	process.exitCode = 1;
});
