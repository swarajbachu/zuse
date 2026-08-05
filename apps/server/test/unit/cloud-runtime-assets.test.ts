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
	});

	test("refuses to publish a runtime manifest with a placeholder or insecure artifact URL", async () => {
		const build = await readWorkspaceFile(
			"apps/server/scripts/build-linux-runtime.mjs",
		);

		expect(build).toContain('throw new Error("ZUSE_RUNTIME_URL is required")');
		expect(build).toContain(
			'throw new Error("ZUSE_RUNTIME_URL must use HTTPS")',
		);
		expect(build).not.toContain("releases.invalid");
	});
});
