import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import { WIRE_PROTOCOL_VERSION } from "../../../packages/contracts/src/handshake.ts";
import { readBoatEnvironment } from "../src/boat-environment.ts";
import { supportsSandboxBilling } from "../src/sandbox-provider-availability.ts";
import { assertRuntimeCompatibility } from "./runtime-deploy-compatibility.mjs";

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
const boat = readBoatEnvironment(vars);
const boatEnabled = boat.BOAT_ADAPTER_ENABLED === "true";
const e2bEnabled = vars.E2B_ADAPTER_ENABLED === "true";
const boxdEnabled = vars.BOXD_ADAPTER_ENABLED === "true";
if (
	boxdEnabled &&
	!supportsSandboxBilling(
		"boxd",
		vars.CLOUD_BILLING_ENFORCEMENT_ENABLED === "true",
		typeof vars.CLOUD_BOXD_ESTIMATES_CUTOVER_AT === "string" &&
			Number.isFinite(Date.parse(vars.CLOUD_BOXD_ESTIMATES_CUTOVER_AT)),
	)
) {
	console.error(
		"BOXD_ADAPTER_ENABLED cannot be true when CLOUD_BILLING_ENFORCEMENT_ENABLED is true.",
	);
	process.exit(1);
}
const slackEnabled = vars.SLACK_ENABLED === "true";
const requiredValues = {
	...(boatEnabled
		? {
				BOAT_TEMPLATE_SNAPSHOT: boat.BOAT_TEMPLATE_SNAPSHOT,
				BOAT_TEMPLATE_VERSION: boat.BOAT_TEMPLATE_VERSION,
			}
		: {}),
	...(boxdEnabled
		? {
				BOXD_TEMPLATE_SNAPSHOT: vars.BOXD_TEMPLATE_SNAPSHOT,
				BOXD_TEMPLATE_VERSION: vars.BOXD_TEMPLATE_VERSION,
			}
		: {}),
	HYPERDRIVE: config.hyperdrive?.[0]?.id,
	R2: config.r2_buckets?.[0]?.bucket_name,
	...(e2bEnabled
		? {
				E2B_TEMPLATE_ID: vars.E2B_TEMPLATE_ID,
				E2B_TEMPLATE_VERSION: vars.E2B_TEMPLATE_VERSION,
			}
		: {}),
	CLOUD_WORKSPACE_RUNTIME_MANIFEST_URL:
		vars.CLOUD_WORKSPACE_RUNTIME_MANIFEST_URL,
	CLOUD_WORKSPACE_RUNTIME_SIGNING_PUBLIC_JWK:
		vars.CLOUD_WORKSPACE_RUNTIME_SIGNING_PUBLIC_JWK,
	GITHUB_APP_ID: vars.GITHUB_APP_ID,
	GITHUB_APP_SLUG: vars.GITHUB_APP_SLUG,
	GITHUB_APP_CLIENT_ID: vars.GITHUB_APP_CLIENT_ID,
	POLAR_PRODUCT_CLOUD_WORKSPACE_STANDARD_V1:
		vars.POLAR_PRODUCT_CLOUD_WORKSPACE_STANDARD_V1,
	POLAR_CLOUD_OVERAGE_METER_ID: vars.POLAR_CLOUD_OVERAGE_METER_ID,
	CLOUD_BILLING_CUTOVER_AT: vars.CLOUD_BILLING_CUTOVER_AT,
	...(slackEnabled
		? {
				SLACK_APP_ID: vars.SLACK_APP_ID,
				SLACK_CLIENT_ID: vars.SLACK_CLIENT_ID,
				SLACK_PUBLIC_ORIGIN: vars.SLACK_PUBLIC_ORIGIN,
				SLACK_JOBS: config.queues?.producers?.find(
					(producer) => producer.binding === "SLACK_JOBS",
				)?.queue,
			}
		: {}),
};
const missingValues = Object.entries(requiredValues)
	.filter(([, value]) => typeof value !== "string" || value.trim() === "")
	.map(([name]) => name);
const enabledAdapters = new Set([
	...(e2bEnabled ? ["e2b"] : []),
	...(boatEnabled ? ["box", "boat"] : []),
	...(boxdEnabled ? ["boxd"] : []),
]);
const cloudAuthProvider =
	(typeof vars.CLOUD_AUTH_PROVIDER_ID === "string"
		? vars.CLOUD_AUTH_PROVIDER_ID.trim()
		: "") || "e2b";
if (!enabledAdapters.has(cloudAuthProvider)) {
	console.error(
		`CLOUD_AUTH_PROVIDER_ID names a provider that is not enabled: ${cloudAuthProvider}.`,
	);
	process.exit(1);
}
if (vars.POLAR_ENVIRONMENT !== "production" || missingValues.length > 0) {
	console.error(
		`Production configuration is incomplete: ${missingValues.join(", ") || "POLAR_ENVIRONMENT"}.`,
	);
	process.exit(1);
}

const runtimeResponse = await fetch(vars.CLOUD_WORKSPACE_RUNTIME_MANIFEST_URL, {
	signal: AbortSignal.timeout(15_000),
});
if (!runtimeResponse.ok)
	throw new Error(
		`Production runtime manifest request failed: ${runtimeResponse.status}`,
	);
assertRuntimeCompatibility(
	await runtimeResponse.json(),
	vars.CLOUD_WORKSPACE_RUNTIME_SIGNING_PUBLIC_JWK,
	WIRE_PROTOCOL_VERSION,
);

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
	...(boatEnabled && !installedSecrets.has("BOX_API_KEY")
		? ["BOAT_API_KEY"]
		: []),
	...(boxdEnabled ? ["BOXD_API_KEY"] : []),
	"RELAY_MINT_PRIVATE_JWK",
	"WORKOS_API_KEY",
	"CF_API_TOKEN",
	...(e2bEnabled ? ["E2B_API_KEY", "E2B_WEBHOOK_SECRET"] : []),
	"CLOUD_CREDENTIAL_VAULT_KEY",
	"POLAR_ACCESS_TOKEN",
	"POLAR_WEBHOOK_SECRET",
	"GITHUB_APP_PRIVATE_KEY",
	...(slackEnabled ? ["SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET"] : []),
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
