import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

const readWorkspaceFile = (relativePath: string) =>
	readFile(new URL(`../../../../${relativePath}`, import.meta.url), "utf8");

describe("cloud runtime assets", () => {
	test("prepares repository snapshots without installing project dependencies", async () => {
		const builder = await readWorkspaceFile(
			"infra/cloud-sandboxes/project-builder.sh",
		);
		const reconciler = await readWorkspaceFile(
			"infra/relay/src/cloud-workspace-reconciler.ts",
		);

		expect(builder).not.toContain("repository-script.ts setup");
		expect(builder).not.toContain("ZUSE_SETUP_COMMAND");
		expect(reconciler).not.toContain("ZUSE_SETUP_COMMAND");
	});

	test("boots workspace-native runtime without an inbound provider endpoint", async () => {
		const bootstrap = await readWorkspaceFile(
			"infra/cloud-sandboxes/workspace-bootstrap.sh",
		);
		const reconciler = await readWorkspaceFile(
			"infra/relay/src/cloud-workspace-reconciler.ts",
		);
		const runtime = await readWorkspaceFile(
			"apps/server/src/relay/cloud-workspace-runtime.ts",
		);

		expect(runtime).toContain("bootTokenFile");
		expect(bootstrap).toContain("export ZUSE_HOST=127.0.0.1");
		expect(bootstrap).toContain('touch "$status_dir/repository-ready"');
		expect(bootstrap).toContain(
			"runtime_command=(node /opt/zuse/current/bin.mjs serve)",
		);
		expect(bootstrap).not.toContain(
			"runtime_command=(node /opt/zuse/current/bin.mjs serve --foreground)",
		);
		expect(reconciler).toContain('exec node "$runtime" serve');
		expect(reconciler).toContain("replacingFailedSandbox");
		expect(reconciler).toContain(
			"yield* provider.kill(workspace.providerSandboxId)",
		);
		expect(bootstrap).not.toContain("workspace-ready.ts");
		expect(runtime).toContain("bootstrap.gatewayUrl");
		expect(runtime).toContain("decodeWorkspaceGatewayFrame");
		expect(runtime).toContain("encodeWorkspaceGatewayFrame");
		expect(runtime).not.toContain('encoding: "base64"');
		expect(runtime).not.toContain("setTimeout(resolve");
	});

	test("keeps enrollment material owner-only and removable without breaking updates", async () => {
		const cloudInit = await readWorkspaceFile(
			"infra/cloud-machines/bootstrap/cloud-init.yaml.tmpl",
		);

		expect(cloudInit).toContain("path: /var/lib/zuse/enrollment.env");
		expect(cloudInit).toContain("owner: root:root");
		expect(cloudInit).toContain(
			'chown -R "zuse:zuse" /var/lib/zuse /home/zuse',
		);
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
		expect(cloudInit).toContain(
			"ZUSE_RUNTIME_WIRE_PROTOCOL=__WIRE_PROTOCOL_VERSION__",
		);
		expect(cloudInit).toContain(
			'--argjson expected "$ZUSE_RUNTIME_WIRE_PROTOCOL"',
		);
		expect(cloudInit).toContain(".wireProtocolVersion == $expected");
		expect(cloudInit).toContain("Runtime failed its initial health check");
		expect(cloudInit).toContain("zuse-credential-cleanup.path");
		expect(cloudInit).toContain(
			"PathExists=/var/lib/zuse/credential-cleanup-ready",
		);
		expect(cloudInit).toContain("systemctl stop zuse.service");
		expect(cloudInit).toContain("KillMode=control-group");
		expect(cloudInit).toContain("TimeoutStopSec=30");
		expect(cloudInit).toContain(
			'bootstrap_complete="/var/lib/zuse/bootstrap-complete"',
		);
		expect(cloudInit).toContain('if [ -f "$bootstrap_complete" ]; then');
		expect(cloudInit).toContain(
			"if [ ! -f /var/lib/zuse/enrollment.env ]; then",
		);
		expect(cloudInit).toContain("if wait_for_runtime; then");
		expect(cloudInit).toContain(
			'install -o root -g root -m 0600 /dev/null "$bootstrap_complete"',
		);
		expect(cloudInit).toContain(
			"path: /etc/systemd/system/zuse-bootstrap.service",
		);
		expect(cloudInit).toContain(
			"ConditionPathExists=!/var/lib/zuse/bootstrap-complete",
		);
		expect(cloudInit).toContain("ExecStart=/usr/local/lib/zuse/bootstrap.sh");
		expect(cloudInit).toContain("StartLimitBurst=2");
		expect(cloudInit).toContain("Restart=on-failure");
		expect(cloudInit).toContain("RestartSec=30");
		expect(cloudInit).toContain(
			"[systemctl, enable, --now, zuse-bootstrap.service]",
		);
		expect(cloudInit).not.toContain("__INSTALL_VERIFIED_RUNTIME_COMMAND__");
		expect(cloudInit).not.toContain(
			"EnvironmentFile=-/etc/zuse/enrollment.env",
		);
	});

	test("installs a pinned verified Node LTS without interactive package upgrades", async () => {
		const cloudInit = await readWorkspaceFile(
			"infra/cloud-machines/bootstrap/cloud-init.yaml.tmpl",
		);

		expect(cloudInit).toContain('version="24.18.0"');
		expect(cloudInit).toMatch(/node-v\$\{version\}-linux-x64\.tar\.xz/);
		expect(cloudInit).toContain(
			"55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742",
		);
		expect(cloudInit).toContain("sha256sum --check --status");
		expect(cloudInit).toContain("/usr/local/bin/node");
		expect(cloudInit).toContain("/usr/local/bin/npm");
		expect(cloudInit).not.toContain("deb.nodesource.com");
		expect(cloudInit).not.toContain("package_upgrade: true");
		expect(cloudInit).toContain(
			"gpg --batch --yes --dearmor -o /usr/share/keyrings/cloudflare-main.gpg",
		);
	});

	test("ships a versioned idempotent developer toolchain in the signed runtime", async () => {
		const manifest = JSON.parse(
			await readWorkspaceFile("apps/server/scripts/toolchain-manifest.json"),
		) as {
			version: string;
			systemPackages: string[];
			npmPackages: Record<string, string>;
		};
		const reconciler = await readWorkspaceFile(
			"apps/server/scripts/toolchain-reconciler.mjs",
		);
		const build = await readWorkspaceFile(
			"apps/server/scripts/build-linux-runtime.mjs",
		);
		const updater = await readWorkspaceFile(
			"apps/server/scripts/runtime-updater.mjs",
		);

		expect(manifest.version).toMatch(/^\d{4}\.\d{2}\.\d{2}\.\d+$/u);
		expect(manifest.npmPackages["@openai/codex"]).toBe("0.144.5");
		expect(manifest.npmPackages["@anthropic-ai/claude-code"]).toMatch(/^\d/u);
		expect(manifest.npmPackages.bun).toMatch(/^\d/u);
		expect(manifest.systemPackages).toEqual(
			expect.arrayContaining([
				"git",
				"git-lfs",
				"gh",
				"openssh-server",
				"tmux",
				"ripgrep",
				"fd-find",
				"jq",
				"build-essential",
				"python3",
			]),
		);
		expect(build).toContain('"toolchain-reconciler.mjs"');
		expect(build).toContain('"runtime-update-trigger.mjs"');
		expect(build).toContain('"runtime-metadata.json"');
		expect(build).toContain('"toolchain-manifest.json"');
		expect(build).toContain("toolchainManifestBytes");
		expect(build).toContain("toolchainManifest.version");
		expect(reconciler).toContain("toolchain-current");
		expect(reconciler).toMatch(/\.staging-\$\{randomUUID\(\)\}/u);
		expect(reconciler).toContain("previousTarget");
		expect(reconciler).toContain("releaseReady");
		expect(reconciler).toContain(
			"Toolchain version was reused with different contents",
		);
		expect(reconciler).toContain('["ssh", ["-V"]]');
		expect(reconciler).toContain('["tmux", ["-V"]]');
		expect(reconciler).not.toContain('"ssh",\n\t\t"tmux"');
		expect(updater).toContain("ZUSE_RUNTIME_SKIP_TOOLCHAIN");
		expect(reconciler).toContain('"runtime-update-trigger.mjs"');
		expect(updater).toContain('join(release, "toolchain-reconciler.mjs")');
		expect(updater).toContain("manifest.toolchain.sha256");
		expect(updater).toContain(
			"Signed toolchain manifest does not match the runtime",
		);
	});

	test("fails fast and reports a stable bootstrap status without logging secrets", async () => {
		const cloudInit = await readWorkspaceFile(
			"infra/cloud-machines/bootstrap/cloud-init.yaml.tmpl",
		);

		expect(cloudInit).toContain("trap bootstrap_failed EXIT");
		expect(cloudInit).toContain(
			'"$ZUSE_RELAY_URL/v1/machines/$ZUSE_MACHINE_ID/boot-status"',
		);
		expect(cloudInit).toContain('report_boot_status failed "bootstrap-failed"');
		expect(cloudInit).toContain("report_boot_status runtime-installed");
		expect(cloudInit).toContain(
			`if [ -z "\${ZUSE_ENROLLMENT_TOKEN:-}" ]; then`,
		);
		expect(cloudInit).not.toContain(
			"set -a\n        . /var/lib/zuse/enrollment.env",
		);
		expect(cloudInit).not.toContain("set -x");
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
		expect(updater).toContain("if (!(await waitForHealthyRuntime()))");
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
		expect(updater).toContain("Runtime update failed:");
		expect(updater).toContain("diagnostic,");
		expect(updater).toContain(
			'cause instanceof Error ? cause.message : "Unknown runtime update failure"',
		);
		expect(updater).toContain("signal: AbortSignal.timeout(2_000)");
		expect(updater).toContain("const expectedWireProtocol = Number(");
		expect(updater).toContain("wireProtocol.min > expectedWireProtocol");
		expect(updater).toContain(
			"body.wireProtocolVersion === expectedWireProtocol",
		);
		expect(updater).toContain("Number.isInteger(wireProtocol.min)");
		expect(updater).toContain("const waitForHealthyRuntime = async () =>");
		expect(updater).toContain("await rm(currentLink, { force: true })");
		expect(updater).toContain("Rollback runtime failed its health check");
		expect(updater).toContain('process.argv.includes("--check")');
		expect(updater).toContain("ZUSE_RUNTIME_UPDATE_REQUEST_FILE");
		expect(updater).toContain("ZUSE_RUNTIME_UPDATE_STATUS_FILE");
		expect(updater).toContain('phase: "restarting"');
		expect(updater).toContain('phase: "verifying"');
	});

	test("installs a narrow root-owned manual update trigger", async () => {
		const trigger = await readWorkspaceFile(
			"apps/server/scripts/runtime-update-trigger.mjs",
		);

		expect(trigger).toContain("zuse-update-request.path");
		expect(trigger).toContain("PathExists=" + "$" + "{requestFile}");
		expect(trigger).toContain("ExecStartPre=/bin/sleep 2");
		expect(trigger).toContain('"0770"');
		expect(trigger).toContain('"zuse"');
		expect(trigger).toContain(
			"ExecStart=/usr/local/bin/node /opt/zuse/current/runtime-updater.mjs",
		);
		expect(trigger).toContain(
			"ExecStopPost=/usr/bin/rm -f " + "$" + "{requestFile}",
		);
		expect(trigger).not.toContain("sudo");
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
		expect(build).toContain(
			'import { WIRE_PROTOCOL_VERSION } from "@zuse/contracts"',
		);
		expect(build).toContain(
			"wireProtocol: { min: WIRE_PROTOCOL_VERSION, max: WIRE_PROTOCOL_VERSION }",
		);
		expect(build).toContain("appVersion,");
		const buildConfig = await readWorkspaceFile(
			"apps/server/tsdown.cloud.config.ts",
		);
		expect(buildConfig).toContain("codeSplitting: false");
		expect(buildConfig).not.toContain('"keytar"');
		expect(build).not.toContain("releases.invalid");
	});

	test("gates automatic and explicit runtime publication", async () => {
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
		expect(workflow).toContain('"$REQUESTED_TARGET" == "production"');
		expect(workflow).toContain("refs/tags/v*");
		expect(workflow.match(/id: publication/gu)).toHaveLength(1);
		expect(
			workflow.match(/steps\.publication\.outputs\.enabled == 'true'/gu),
		).toHaveLength(2);
		expect(
			workflow.match(/needs\.build\.outputs\.publish == 'true'/gu),
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
		expect(workflow).not.toContain("relay.zuse.sh");
	});
});
