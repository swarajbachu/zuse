import { runServePackageCli } from "@zuse/server/serve-cli";
import packageMetadata from "../package.json" with { type: "json" };
import type { ServeCli } from "./cli-types.ts";

export const runServeCli: ServeCli = (argv, env = process.env): Promise<void> =>
	runServePackageCli(argv, env, {
		packageVersion: packageMetadata.version,
	});
