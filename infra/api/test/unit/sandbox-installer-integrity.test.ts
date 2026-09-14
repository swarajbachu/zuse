import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.each([
	"grok",
	"nodesource",
])("rejects a tampered %s installer before execution", (kind) => {
	const root = mkdtempSync(join(tmpdir(), "zuse-installer-check-"));
	try {
		const marker = join(root, "executed");
		const installer = join(root, "installer");
		let script: string;
		if (kind === "grok") {
			const source = readFileSync(
				new URL("../../../cloud-sandboxes/provision.sh", import.meta.url),
				"utf8",
			);
			script = `${source
				.slice(0, source.indexOf('for stage in "$@"'))
				.replaceAll("/tmp/install-grok.sh", installer)}\nstage_globals`;
		} else {
			const source = readFileSync(
				new URL("../../../cloud-sandboxes/box/install.sh", import.meta.url),
				"utf8",
			);
			script = source
				.slice(0, source.indexOf("\napt-get update"))
				.replaceAll("/tmp/zuse-nodesource-setup.sh", installer);
		}
		const stubs = [
			"node() { echo v20.0.0; }",
			"npm() { :; }",
			"mkdir() { :; }",
			'curl() { local last; for last; do :; done; printf "tampered" > "$last"; }',
			'bash() { touch "$ZUSE_TEST_EXECUTION_MARKER"; }',
		].join("\n");
		const result = spawnSync("bash", ["-c", `${stubs}\n${script}`], {
			env: { ...process.env, ZUSE_TEST_EXECUTION_MARKER: marker },
			encoding: "utf8",
		});
		expect(result.status).not.toBe(0);
		expect(existsSync(marker)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
