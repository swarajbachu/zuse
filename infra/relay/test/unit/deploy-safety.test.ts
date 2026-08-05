import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { WORKOS_STAGING_PUBLIC_CLIENT_ID } from "@zuse/contracts";
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
const relayDirectory = fileURLToPath(new URL("../..", import.meta.url));

interface WranglerTarget {
	readonly name: string;
	readonly routes: ReadonlyArray<{ readonly pattern: string }>;
	readonly vars: Readonly<Record<string, string>>;
	readonly hyperdrive: ReadonlyArray<{
		readonly binding: string;
		readonly id: string;
	}>;
}

describe("relay deployment safety", () => {
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
			expect(command).toMatch(/ --env=$/);
		}
	});

	test("keeps staging as the default with live operations disabled", async () => {
		const config = parse(
			await readFile(wranglerConfigUrl, "utf8"),
		) as WranglerTarget;

		expect(config.name).toBe("zuse-relay-staging");
		expect(config.routes).toEqual([
			{ pattern: "relay-staging.stuff.md", custom_domain: true },
		]);
		expect(config.vars.RELAY_ISSUER).toBe("https://relay-staging.stuff.md");
		expect(config.vars.MANAGED_TUNNEL_NAMESPACE).toBe("zenv-staging");
		expect(config.vars.WORKOS_JWKS_URL).toBe(
			`https://api.workos.com/sso/jwks/${WORKOS_STAGING_PUBLIC_CLIENT_ID}`,
		);
		expect(config.vars.MACHINE_ALPHA_ALLOWLIST).toBe(
			"user_01KW7R9WGJFFSKDNESE7RN00N1",
		);
		expect(config.vars.MACHINE_PROVIDER).toBe("fake");
		expect(config.vars.HETZNER_ADAPTER_ENABLED).toBe("false");
		expect(config.vars.HETZNER_FIREWALL_ID).toBe("11418954");
		expect(config.vars.MACHINE_RUNTIME_MANIFEST_URL).toBe(
			"https://github.com/swarajbachu/zuse/releases/download/cloud-runtime-staging/stable-manifest.json",
		);
		expect(() =>
			JSON.parse(config.vars.MACHINE_RUNTIME_SIGNING_PUBLIC_JWK ?? ""),
		).not.toThrow();
		expect(config.vars.MACHINE_LIVE_CHECKOUT_ENABLED).toBe("false");
		expect(config.vars.POLAR_VPS_SALES_APPROVED).toBe("false");
		expect(config.hyperdrive).toEqual([
			{
				binding: "HYPERDRIVE",
				id: "dfc67e0586ff4c288cb645ed63c65d9a",
			},
		]);
		expect(config).not.toHaveProperty("env");
	});

	test("requires a separate production configuration and guard", async () => {
		const production = parse(
			await readFile(productionWranglerConfigUrl, "utf8"),
		) as WranglerTarget;

		expect(production.name).toBe("zuse-relay");
		expect(production.routes).toEqual([
			{ pattern: "relay.stuff.md", custom_domain: true },
		]);
		expect(production.vars.MACHINE_PROVIDER).toBe("fake");
		expect(production.vars.HETZNER_ADAPTER_ENABLED).toBe("false");
		expect(production.vars.MACHINE_LIVE_CHECKOUT_ENABLED).toBe("false");
		expect(production.vars.MACHINE_RUNTIME_MANIFEST_URL).toBe("");
		expect(production.vars.MACHINE_RUNTIME_SIGNING_PUBLIC_JWK).toBe("");
		expect(production.hyperdrive).toEqual([
			{
				binding: "HYPERDRIVE",
				id: "c49c02e939494a958fb5fe6805e7b0f2",
			},
		]);
		expect(await readFile(productionDeployScriptUrl, "utf8")).toContain(
			'["wrangler", "deploy", "--config", "wrangler.production.jsonc"]',
		);

		const result = spawnSync("node", ["scripts/deploy-production.mjs"], {
			cwd: relayDirectory,
			encoding: "utf8",
			env: {
				...process.env,
				ZUSE_CONFIRM_PRODUCTION_RELAY_DEPLOY: "",
			},
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Refusing to deploy the production relay");
	});

	test("rejects a non-staging database from the default migration command", () => {
		const result = spawnSync(
			"node",
			["scripts/migrate-database.mjs", "staging"],
			{
				cwd: relayDirectory,
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
			"DATABASE_URL is not the staging Neon database",
		);
	});

	test("has no generic production migration target", () => {
		const result = spawnSync(
			"node",
			["scripts/migrate-database.mjs", "production"],
			{
				cwd: relayDirectory,
				encoding: "utf8",
				env: {
					...process.env,
					DATABASE_URL: "postgresql://example.invalid/unknown?sslmode=require",
				},
			},
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"Only the staging database has a configured migration target",
		);
	});
});
