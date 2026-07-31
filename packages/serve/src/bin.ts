#!/usr/bin/env node

import { runServeCli } from "./cli.ts";

runServeCli(process.argv.slice(2), process.env).catch((cause) => {
	console.error(cause instanceof Error ? cause.message : String(cause));
	process.exitCode = 1;
});
