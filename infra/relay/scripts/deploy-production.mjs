import { spawnSync } from "node:child_process";

const confirmation = "deploy-relay.stuff.md";

if (process.env.ZUSE_CONFIRM_PRODUCTION_RELAY_DEPLOY !== confirmation) {
	console.error(
		[
			"Refusing to deploy the production relay.",
			"Use `bun run deploy` for the isolated staging environment.",
			`For an intentional production deploy, set ZUSE_CONFIRM_PRODUCTION_RELAY_DEPLOY=${confirmation}.`,
		].join("\n"),
	);
	process.exit(1);
}

const result = spawnSync(
	"bunx",
	["wrangler", "deploy", "--config", "wrangler.production.jsonc"],
	{
		stdio: "inherit",
	},
);

if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
