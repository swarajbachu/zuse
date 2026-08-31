import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { parse } from "jsonc-parser";

const confirmation = "deploy-api.zuse.sh";
const configPath = "wrangler.production.jsonc";

if (process.env.ZUSE_CONFIRM_PRODUCTION_API_DEPLOY !== confirmation) {
	console.error(
		[
			"Refusing to deploy the production api.",
			"Use `bun run deploy` for the isolated staging environment.",
			`For an intentional production deploy, set ZUSE_CONFIRM_PRODUCTION_API_DEPLOY=${confirmation}.`,
		].join("\n"),
	);
	process.exit(1);
}

const config = parse(readFileSync(configPath, "utf8"));
const vars = config.vars ?? {};
const requiredValues = {
	HYPERDRIVE: config.hyperdrive?.[0]?.id,
	R2: config.r2_buckets?.[0]?.bucket_name,
	E2B_TEMPLATE_ID: vars.E2B_TEMPLATE_ID,
	E2B_TEMPLATE_VERSION: vars.E2B_TEMPLATE_VERSION,
	CLOUD_WORKSPACE_RUNTIME_MANIFEST_URL:
		vars.CLOUD_WORKSPACE_RUNTIME_MANIFEST_URL,
	CLOUD_WORKSPACE_RUNTIME_SIGNING_PUBLIC_JWK:
		vars.CLOUD_WORKSPACE_RUNTIME_SIGNING_PUBLIC_JWK,
	POSTHOG_HOST: vars.POSTHOG_HOST,
	POSTHOG_CLOUD_BETA_FLAG_KEY: vars.POSTHOG_CLOUD_BETA_FLAG_KEY,
	GITHUB_APP_ID: vars.GITHUB_APP_ID,
	GITHUB_APP_SLUG: vars.GITHUB_APP_SLUG,
	GITHUB_APP_CLIENT_ID: vars.GITHUB_APP_CLIENT_ID,
	POLAR_PRODUCT_CLOUD_WORKSPACE_STANDARD_V1:
		vars.POLAR_PRODUCT_CLOUD_WORKSPACE_STANDARD_V1,
	POLAR_CLOUD_OVERAGE_METER_ID: vars.POLAR_CLOUD_OVERAGE_METER_ID,
	CLOUD_BILLING_CUTOVER_AT: vars.CLOUD_BILLING_CUTOVER_AT,
};
const missingValues = Object.entries(requiredValues)
	.filter(([, value]) => typeof value !== "string" || value.trim() === "")
	.map(([name]) => name);
if (
	vars.E2B_ADAPTER_ENABLED !== "true" ||
	vars.POLAR_ENVIRONMENT !== "production" ||
	missingValues.length > 0
) {
	console.error(
		`Production configuration is incomplete: ${missingValues.join(", ") || "E2B_ADAPTER_ENABLED/POLAR_ENVIRONMENT"}.`,
	);
	process.exit(1);
}

const secretsResult = spawnSync(
	"bunx",
	["wrangler", "secret", "list", "--config", configPath, "--format", "json"],
	{ encoding: "utf8" },
);
if (secretsResult.error !== undefined) throw secretsResult.error;
if (secretsResult.status !== 0) {
	process.stderr.write(secretsResult.stderr);
	process.exit(secretsResult.status ?? 1);
}
const installedSecrets = new Set(
	JSON.parse(secretsResult.stdout).map((secret) => secret.name),
);
const requiredSecrets = [
	"RELAY_MINT_PRIVATE_JWK",
	"WORKOS_API_KEY",
	"CF_API_TOKEN",
	"E2B_API_KEY",
	"E2B_WEBHOOK_SECRET",
	"CLOUD_CREDENTIAL_VAULT_KEY",
	"POSTHOG_PROJECT_TOKEN",
	"POLAR_ACCESS_TOKEN",
	"POLAR_WEBHOOK_SECRET",
	"GITHUB_APP_PRIVATE_KEY",
];
const missingSecrets = requiredSecrets.filter(
	(secret) => !installedSecrets.has(secret),
);
if (missingSecrets.length > 0) {
	console.error(
		`Production secrets are incomplete: ${missingSecrets.join(", ")}.`,
	);
	process.exit(1);
}

const result = spawnSync(
	"bunx",
	["wrangler", "deploy", "--config", configPath],
	{ stdio: "inherit" },
);

if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
