import packageMetadata from "../package.json" with { type: "json" };
import { isAgentCliCommand, runAgentCli } from "./agent-cli.ts";
import type { ServeCli } from "./cli-types.ts";

export const runServeCli: ServeCli = async (
	argv,
	env = process.env,
): Promise<void> => {
	if (isAgentCliCommand(argv)) return runAgentCli(argv, env);
	const { runServePackageCli } = await import("@zusehq/server/serve-cli");
	return runServePackageCli(argv, env, {
		packageVersion: packageMetadata.version,
	});
};
