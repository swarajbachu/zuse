import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

const readWorkspaceFile = (relativePath: string) =>
	readFile(new URL(`../../../../${relativePath}`, import.meta.url), "utf8");

describe("cloud runtime assets", () => {
	test("keeps enrollment material owner-only and removable without breaking updates", async () => {
		const cloudInit = await readWorkspaceFile(
			"infra/cloud-machines/bootstrap/cloud-init.yaml.tmpl",
		);

		expect(cloudInit).toContain("path: /var/lib/zuse/enrollment.env");
		expect(cloudInit).toContain("owner: zuse:zuse");
		expect(cloudInit).toContain(
			"ZUSE_ENROLLMENT_TOKEN_FILE=/var/lib/zuse/enrollment.env",
		);
		expect(cloudInit).toContain("path: /etc/zuse/runtime.env");
		expect(cloudInit).toContain("EnvironmentFile=/etc/zuse/runtime.env");
		expect(cloudInit).toContain("ZUSE_MACHINE_RUNTIME_ROLE=cloud-environment");
		expect(cloudInit).toContain(
			"path: /usr/local/lib/zuse/runtime-installer.mjs",
		);
		expect(cloudInit).toContain("__RUNTIME_INSTALLER_SOURCE__");
		expect(cloudInit).toContain("ZUSE_RUNTIME_INSTALL_ONLY=1");
		expect(cloudInit).toContain("http://127.0.0.1:47837/healthz");
		expect(cloudInit).toContain("curl --max-time 2 --connect-timeout 1");
		expect(cloudInit).toContain(".wireProtocolVersion == 2");
		expect(cloudInit).toContain("Runtime failed its initial health check");
		expect(cloudInit).not.toContain("__INSTALL_VERIFIED_RUNTIME_COMMAND__");
		expect(cloudInit).not.toContain(
			"EnvironmentFile=-/etc/zuse/enrollment.env",
		);
	});

	test("denies public inbound traffic and limits host services to the private interface", async () => {
		const cloudInit = await readWorkspaceFile(
			"infra/cloud-machines/bootstrap/cloud-init.yaml.tmpl",
		);

		expect(cloudInit).toContain(
			"type filter hook input priority 0; policy drop;",
		);
		expect(cloudInit).toContain(
			'iifname "tailscale0" tcp dport { 22, 47837 } accept',
		);
		expect(cloudInit).not.toMatch(/^\s+tcp dport (22|47837) accept$/mu);
	});

	test("uses immutable release directories and restores the prior target after a failed health check", async () => {
		const updater = await readWorkspaceFile(
			"apps/server/scripts/runtime-updater.mjs",
		);

		expect(updater).toContain("manifest.sha256.slice(0, 12)");
		expect(updater).not.toContain(
			"await rm(release, { recursive: true, force: true })",
		);
		expect(updater).toContain("if (!healthy)");
		expect(updater).toContain("previousTarget = await readlink(currentLink)");
		expect(updater).toContain("await symlink(previousTarget, rollbackLink)");
		expect(updater).not.toContain("currentLink}.target");
		expect(updater).toContain(
			'await run("systemctl", ["restart", "zuse.service"])',
		);
		expect(updater).toContain('process.env.ZUSE_RUNTIME_INSTALL_ONLY === "1"');
		expect(updater).toContain("if (installOnly)");
		expect(updater).toContain("const fetchWithRetry");
		expect(updater).toContain("AbortSignal.timeout");
		expect(updater).toContain("Runtime hash is invalid");
		expect(updater).toContain("signal: AbortSignal.timeout(2_000)");
	});

	test("refuses to publish a runtime manifest with a placeholder or insecure artifact URL", async () => {
		const build = await readWorkspaceFile(
			"apps/server/scripts/build-linux-runtime.mjs",
		);

		expect(build).toContain('throw new Error("ZUSE_RUNTIME_URL is required")');
		expect(build).toContain(
			'throw new Error("ZUSE_RUNTIME_URL must use HTTPS")',
		);
		expect(build).toContain("Cloud runtime unexpectedly imports keytar");
		expect(build).toContain('"node-gyp-build"');
		const buildConfig = await readWorkspaceFile(
			"apps/server/tsdown.cloud.config.ts",
		);
		expect(buildConfig).toContain("codeSplitting: false");
		expect(buildConfig).not.toContain('"keytar"');
		expect(build).not.toContain("releases.invalid");
	});

	test("gates automatic and explicit staging publication without deploying production", async () => {
		const workflow = await readWorkspaceFile(
			".github/workflows/cloud-runtime-staging.yml",
		);

		expect(workflow).toContain("branches: [main]");
		expect(workflow).toContain("ZUSE_RUNTIME_SIGNING_PRIVATE_JWK");
		expect(workflow).toContain("Generate ephemeral verification signing key");
		expect(workflow).toContain("Load trusted signing key");
		expect(workflow).toContain(
			'"$GITHUB_EVENT_NAME" == "push" && "$GITHUB_REF" == "refs/heads/main"',
		);
		expect(workflow).toContain("publish_staging:");
		expect(workflow).toContain(
			"refs/heads/swarajbachu/managed-vps-cloud-provisioning",
		);
		expect(workflow.match(/id: publication/gu)).toHaveLength(1);
		expect(
			workflow.match(/steps\.publication\.outputs\.enabled == 'true'/gu),
		).toHaveLength(2);
		expect(
			workflow.match(/needs\.build\.outputs\.publish_staging == 'true'/gu),
		).toHaveLength(1);
		expect(workflow).not.toContain(
			"ZUSE_RUNTIME_SIGNING_PRIVATE_JWK: $" +
				"{{ secrets.ZUSE_RUNTIME_SIGNING_PRIVATE_JWK }}",
		);
		expect(workflow).toContain("cloud-runtime-staging");
		expect(workflow).toContain("stable-manifest.json");
		expect(workflow).toContain("Smoke-test clean runtime archive");
		expect(workflow).toContain('require("tree-sitter-typescript")');
		expect(workflow).toContain('await import("./bin.mjs")');
		expect(workflow).toContain("--clobber");
		expect(workflow).not.toContain("if: github.event_name != 'pull_request'");
		expect(workflow).not.toContain("wrangler deploy");
		expect(workflow).not.toContain("relay.stuff.md");
	});
});
