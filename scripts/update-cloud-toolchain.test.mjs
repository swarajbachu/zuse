import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "cloud-update-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const put = (path, text) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	};
	put(
		"scripts/update-cloud-toolchain.mjs",
		readFileSync(new URL("./update-cloud-toolchain.mjs", import.meta.url)),
	);
	put(
		"apps/server/scripts/toolchain-manifest.json",
		JSON.stringify({
			version: "2026.09.22.1",
			npmPackages: {
				"@openai/codex": "1.0.0",
				"@anthropic-ai/claude-code": "1.0.0",
			},
		}),
	);
	put(
		"infra/cloud-sandboxes/provision.sh",
		"@openai/codex@1.0.0 @anthropic-ai/claude-code@1.0.0",
	);
	for (const path of [
		"package.json",
		"packages/contracts/src/cloud-auth.ts",
		"apps/server/test/unit/cloud-runtime-assets.test.ts",
	])
		put(path, '{"version":"1.0.0"}');
	put(
		"bin/npm",
		"#!/usr/bin/env node\nconsole.log(JSON.stringify(process.env.TEST_VERSION));\n",
	);
	return {
		root,
		put,
		run(version) {
			return spawnSync(
				process.execPath,
				[join(root, "scripts/update-cloud-toolchain.mjs")],
				{
					encoding: "utf8",
					env: {
						...process.env,
						PATH: `${join(root, "bin")}:${process.env.PATH}`,
						TEST_VERSION: version,
					},
				},
			);
		},
	};
}

// No network: the executable registry fixture provides candidate versions.
import { chmodSync } from "node:fs";

for (const version of ["1.0.0", "1.1.0", "0.9.0", "2.0.0-beta.1"]) {
	test(`registry candidate ${version}`, (t) => {
		const f = fixture(t);
		chmodSync(join(f.root, "bin/npm"), 0o755);
		const result = f.run(version);
		assert.equal(
			result.status,
			version.startsWith("1.") ? 0 : 1,
			result.stderr,
		);
		const manifest = JSON.parse(
			readFileSync(join(f.root, "apps/server/scripts/toolchain-manifest.json")),
		);
		assert.equal(
			manifest.npmPackages["@openai/codex"],
			version === "1.1.0" ? version : "1.0.0",
		);
		if (version === "1.1.0") {
			assert.notEqual(manifest.version, "2026.09.22.1");
			assert.match(
				readFileSync(
					join(f.root, "infra/cloud-sandboxes/provision.sh"),
					"utf8",
				),
				/@openai\/codex@1\.1\.0/,
			);
		}
	});
}
test("pin drift fails without partial writes", (t) => {
	const f = fixture(t);
	chmodSync(join(f.root, "bin/npm"), 0o755);
	f.put("packages/contracts/src/cloud-auth.ts", '"unexpected"');
	assert.equal(f.run("1.1.0").status, 1);
	assert.equal(
		readFileSync(join(f.root, "package.json"), "utf8"),
		'{"version":"1.0.0"}',
	);
});
