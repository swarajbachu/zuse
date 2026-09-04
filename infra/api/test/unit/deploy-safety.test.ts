import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
	STAGING_API_URL,
	WORKOS_STAGING_PUBLIC_CLIENT_ID,
} from "@zuse/contracts";
import { parse } from "jsonc-parser";
import { describe, expect, test } from "vitest";

const packageJsonUrl = new URL("../../package.json", import.meta.url);
const wranglerConfigUrl = new URL("../../wrangler.jsonc", import.meta.url);
const productionWranglerConfigUrl = new URL(
	"../../wrangler.production.jsonc",
	import.meta.url,
);
const productionDeployScriptUrl = new URL(
	"../../scripts/deploy-production.mjs",
	import.meta.url,
);
const templateResourcesUrl = new URL(
	"../../../cloud-sandboxes/template-resources.json",
	import.meta.url,
);
const runtimeWorkflowUrl = new URL(
	"../../../../.github/workflows/cloud-runtime-staging.yml",
	import.meta.url,
);
const apiDirectory = fileURLToPath(new URL("../..", import.meta.url));

interface WranglerTarget {
	readonly name: string;
	readonly placement?: { readonly region: string };
	readonly routes: ReadonlyArray<{ readonly pattern: string }>;
	readonly vars: Readonly<Record<string, string>>;
	readonly hyperdrive: ReadonlyArray<{
		readonly binding: string;
		readonly id: string;
	}>;
	readonly durable_objects: {
		readonly bindings: ReadonlyArray<{
			readonly name: string;
			readonly class_name: string;
		}>;
	};
	readonly migrations: ReadonlyArray<{
		readonly tag: string;
		readonly new_sqlite_classes?: readonly string[];
	}>;
}

describe("api deployment safety", () => {
	test("makes unqualified deploy and secret commands target staging", async () => {
		const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8")) as {
			readonly scripts: Readonly<Record<string, string>>;
		};

		expect(packageJson.scripts.deploy).toBe("wrangler deploy --env=");
		expect(packageJson.scripts["deploy:staging"]).toBe(
			"wrangler deploy --env=",
		);
		expect(packageJson.scripts["deploy:production"]).toBe(
			"node scripts/deploy-production.mjs",
		);
		for (const [name, command] of Object.entries(packageJson.scripts)) {
			if (!name.startsWith("secret")) continue;
			if (name.endsWith(":production")) {
				expect(command).toContain("--config wrangler.production.jsonc");
			} else {
				expect(command).toMatch(/ --env=$/);
			}
		}
	});

	test("keeps the allowlisted sandbox workflow live only on staging", async () => {
		const config = parse(
			await readFile(wranglerConfigUrl, "utf8"),
		) as WranglerTarget;

		expect(config.name).toBe("zuse-relay-staging");
		expect(config.routes).toEqual([
			{ pattern: "api-staging.stuff.md", custom_domain: true },
		]);
		expect(config.vars.API_ISSUER).toBe(STAGING_API_URL);
		expect(config.vars.CLOUD_COMMAND_MAILBOX_ENABLED).toBe("true");
		expect(`https://${config.routes[0]?.pattern}`).toBe(STAGING_API_URL);
		expect(config.vars.MANAGED_TUNNEL_NAMESPACE).toBe("zenv-staging");
		expect(config.vars.WORKOS_JWKS_URL).toBe(
			`https://api.workos.com/sso/jwks/${WORKOS_STAGING_PUBLIC_CLIENT_ID}`,
		);
		expect(config.vars.MACHINE_ALPHA_ALLOWLIST).toBe(
			"user_01KW7R9WGJFFSKDNESE7RN00N1,user_01M0HA239JJ7P73AA1X5M8KDHF",
		);
		expect(config.vars.MACHINE_MANUAL_ENTITLEMENTS).toBe("true");
		expect(config.vars.MACHINE_PROVIDER).toBe("hetzner");
		expect(config.vars.HETZNER_ADAPTER_ENABLED).toBe("true");
		expect(config.vars.HETZNER_FIREWALL_ID).toBe("11418954");
		expect(config.vars.MACHINE_RUNTIME_MANIFEST_URL).toBe(
			"https://github.com/swarajbachu/zuse/releases/download/cloud-runtime-staging/stable-manifest.json",
		);
		expect(() =>
			JSON.parse(config.vars.MACHINE_RUNTIME_SIGNING_PUBLIC_JWK ?? ""),
		).not.toThrow();
		expect(config.vars.MACHINE_LIVE_CHECKOUT_ENABLED).toBe("true");
		expect(config.vars.CLOUD_WORKSPACE_RUNTIME_MANIFEST_URL).toBe(
			"https://github.com/swarajbachu/zuse/releases/download/cloud-runtime-staging/stable-manifest.json",
		);
		expect(() =>
			JSON.parse(config.vars.CLOUD_WORKSPACE_RUNTIME_SIGNING_PUBLIC_JWK ?? ""),
		).not.toThrow();
		expect(config.vars).not.toHaveProperty("SANDBOX_DEFAULT_PROVIDER");
		expect(config.vars.E2B_ADAPTER_ENABLED).toBe("true");
		expect(config.vars.E2B_TEMPLATE_ID).toBe("zuse-cloud-sandbox");
		expect(config.vars.E2B_TEMPLATE_VERSION).toBe(
			"e147c717-5a91-4d68-a244-f1ca65034a3d",
		);
		expect(config.placement).toEqual({ region: "aws:ap-southeast-1" });
		expect(config.vars.E2B_VCPU_COUNT).toBe("2");
		expect(config.vars.E2B_MEMORY_MIB).toBe("4096");
		expect(config.vars.POLAR_PRODUCT_PERSISTENT_STANDARD_V1).toBe(
			"810223ea-94f2-47e7-9c09-af9a0fd86174",
		);
		expect(config.vars.POLAR_PRODUCT_CLOUD_WORKSPACE_STANDARD_V1).toBe(
			"31616352-13b0-48dd-a9cd-11724f358199",
		);
		expect(config.vars.POLAR_CLOUD_OVERAGE_METER_ID).toBe(
			"c74994e7-b555-4715-a34a-9dd54a006539",
		);
		expect(config.vars.POLAR_VPS_SALES_APPROVED).toBe("false");
		expect(config.hyperdrive).toEqual([
			{
				binding: "HYPERDRIVE",
				id: "dfc67e0586ff4c288cb645ed63c65d9a",
			},
		]);
		expect(config.durable_objects.bindings).toContainEqual({
			name: "WORKSPACE_MAILBOX",
			class_name: "WorkspaceMailbox",
		});
		expect(config.migrations).toContainEqual({
			tag: "v2-workspace-mailbox",
			new_sqlite_classes: ["WorkspaceMailbox"],
		});
		expect(config).not.toHaveProperty("env");
	});

	test("requires a separate production configuration and guard", async () => {
		const production = parse(
			await readFile(productionWranglerConfigUrl, "utf8"),
		) as WranglerTarget;

		expect(production.name).toBe("zuse-relay");
		expect(production.routes).toEqual([
			{ pattern: "api.zuse.sh", custom_domain: true },
		]);
		expect(production.vars.MACHINE_PROVIDER).toBe("fake");
		expect(production.vars.CLOUD_COMMAND_MAILBOX_ENABLED).toBe("true");
		expect(production.vars.HETZNER_ADAPTER_ENABLED).toBe("false");
		expect(production.vars.MACHINE_LIVE_CHECKOUT_ENABLED).toBe("true");
		expect(production.vars.MACHINE_RUNTIME_MANIFEST_URL).toBe("");
		expect(production.vars.MACHINE_RUNTIME_SIGNING_PUBLIC_JWK).toBe("");
		expect(production.vars).not.toHaveProperty("SANDBOX_DEFAULT_PROVIDER");
		expect(production.vars.CLOUD_WORKSPACE_RUNTIME_MANIFEST_URL).toBe(
			"https://github.com/swarajbachu/zuse/releases/download/cloud-runtime-production/stable-manifest.json",
		);
		expect(() =>
			JSON.parse(
				production.vars.CLOUD_WORKSPACE_RUNTIME_SIGNING_PUBLIC_JWK ?? "",
			),
		).not.toThrow();
		expect(production.vars.E2B_ADAPTER_ENABLED).toBe("true");
		expect(production.vars.E2B_TEMPLATE_ID).toBe(
			"zuse-cloud-sandbox-production",
		);
		expect(production.vars.E2B_TEMPLATE_VERSION).toBe(
			"56e72d23-3e0f-4f26-8069-37a4035e39b4",
		);
		expect(production.vars.E2B_VCPU_COUNT).toBe("2");
		expect(production.vars.E2B_MEMORY_MIB).toBe("4096");
		expect(production.vars.POSTHOG_HOST).toBe("https://us.i.posthog.com");
		expect(production.vars.POSTHOG_CLOUD_BETA_FLAG_KEY).toBe(
			"zuse-cloud-beta-access",
		);
		expect(production.vars).not.toHaveProperty("MACHINE_ALPHA_ALLOWLIST");
		expect(production.vars.POLAR_ENVIRONMENT).toBe("production");
		expect(production.vars.POLAR_PRODUCT_CLOUD_WORKSPACE_STANDARD_V1).toBe(
			"80f89e4a-dc3a-44db-8523-b4863168437f",
		);
		expect(production.vars.POLAR_CLOUD_OVERAGE_METER_ID).toBe(
			"30037005-05ba-4bbb-8e6c-f6cab58826b7",
		);
		expect(production.vars.CLOUD_BILLING_CUTOVER_AT).toBe(
			"2026-08-17T18:30:00.000Z",
		);
		expect(production.hyperdrive).toEqual([
			{
				binding: "HYPERDRIVE",
				id: "c49c02e939494a958fb5fe6805e7b0f2",
			},
		]);
		expect(production.durable_objects.bindings).toContainEqual({
			name: "WORKSPACE_MAILBOX",
			class_name: "WorkspaceMailbox",
		});
		expect(production.migrations).toContainEqual({
			tag: "v2-workspace-mailbox",
			new_sqlite_classes: ["WorkspaceMailbox"],
		});
		const deploymentScript = await readFile(productionDeployScriptUrl, "utf8");
		expect(deploymentScript).toContain(
			'["wrangler", "deploy", "--config", configPath]',
		);
		expect(deploymentScript).toContain('"wrangler.production.jsonc"');

		const result = spawnSync("node", ["scripts/deploy-production.mjs"], {
			cwd: apiDirectory,
			encoding: "utf8",
			env: {
				...process.env,
				ZUSE_CONFIRM_PRODUCTION_API_DEPLOY: "",
			},
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Refusing to deploy the production api");
	});

	test("keeps E2B template and billing reservation resources aligned", async () => {
		const template = JSON.parse(
			await readFile(templateResourcesUrl, "utf8"),
		) as { readonly vcpuCount: number; readonly memoryMib: number };
		for (const configUrl of [wranglerConfigUrl, productionWranglerConfigUrl]) {
			const config = parse(await readFile(configUrl, "utf8")) as WranglerTarget;
			expect(Number(config.vars.E2B_VCPU_COUNT)).toBe(template.vcpuCount);
			expect(Number(config.vars.E2B_MEMORY_MIB)).toBe(template.memoryMib);
		}
	});

	test("publishes production runtimes only from a version tag with a separate key", async () => {
		const workflow = await readFile(runtimeWorkflowUrl, "utf8");
		expect(workflow).toContain('tags: ["v*"]');
		expect(workflow).toContain("confirm_non_main_staging");
		expect(workflow).toContain('"$CONFIRM_NON_MAIN_STAGING" != "true"');
		expect(workflow).toContain("release_tag=cloud-runtime-$target");
		expect(workflow).toContain("ZUSE_PRODUCTION_RUNTIME_SIGNING_PRIVATE_JWK");
		expect(
			workflow.indexOf('"dist-cloud/$ZUSE_RUNTIME_ASSET_NAME"'),
		).toBeLessThan(workflow.indexOf('"dist-cloud/stable-manifest.json"'));
	});

	test("rejects a non-staging database from the default migration command", () => {
		const result = spawnSync(
			"node",
			["scripts/migrate-database.mjs", "staging"],
			{
				cwd: apiDirectory,
				encoding: "utf8",
				env: {
					...process.env,
					DATABASE_URL:
						"postgresql://example.invalid/not-staging?sslmode=require",
				},
			},
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"DATABASE_URL is not the approved staging database",
		);
	});

	test("requires explicit production database identity and confirmation", () => {
		const result = spawnSync(
			"node",
			["scripts/migrate-database.mjs", "production"],
			{
				cwd: apiDirectory,
				encoding: "utf8",
				env: {
					...process.env,
					DATABASE_URL: "postgresql://example.invalid/unknown?sslmode=require",
				},
			},
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Refusing to migrate production");

		const mismatchedIdentity = spawnSync(
			"node",
			["scripts/migrate-database.mjs", "production"],
			{
				cwd: apiDirectory,
				encoding: "utf8",
				env: {
					...process.env,
					DATABASE_URL:
						"postgresql://example.invalid/production?sslmode=require",
					ZUSE_CONFIRM_PRODUCTION_DATABASE_MIGRATION: "migrate-api.zuse.sh",
				},
			},
		);
		expect(mismatchedIdentity.status).toBe(1);
		expect(mismatchedIdentity.stderr).toContain(
			"DATABASE_URL does not match the approved production database identity",
		);
	});
});
