#!/usr/bin/env node

import { runServePackageCli } from "@zuse/server/serve-cli";
import packageMetadata from "../package.json" with { type: "json" };

runServePackageCli(process.argv.slice(2), process.env, {
	packageVersion: packageMetadata.version,
}).catch((cause) => {
	console.error(cause instanceof Error ? cause.message : String(cause));
	process.exitCode = 1;
});
