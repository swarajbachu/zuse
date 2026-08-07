#!/usr/bin/env node

import { assertSupportedNodeVersion } from "./node-version.js";

const run = async (): Promise<void> => {
	assertSupportedNodeVersion();
	const { runServeCli } = await import("@zusehq/serve/cli");
	await runServeCli(process.argv.slice(2), process.env);
};

run().catch((cause) => {
	console.error(cause instanceof Error ? cause.message : String(cause));
	process.exitCode = 1;
});
