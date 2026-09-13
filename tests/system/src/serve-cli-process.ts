#!/usr/bin/env node

import { runServePackageCli } from "../../../apps/server/src/serve/package-cli.ts";
import {
	isAgentCliCommand,
	runAgentCli,
} from "../../../packages/serve/src/agent-cli.ts";

const argv = process.argv.slice(2);

(isAgentCliCommand(argv)
	? runAgentCli(argv, process.env)
	: runServePackageCli(argv, process.env, { packageVersion: "0.0.0" })
).catch((cause) => {
	console.error(cause instanceof Error ? cause.message : String(cause));
	process.exitCode = 1;
});
