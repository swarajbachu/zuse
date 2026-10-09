import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const { AppInfo } = builderRequire("app-builder-lib/out/appInfo.js");
const { default: FpmTarget } = builderRequire(
	"app-builder-lib/out/targets/FpmTarget.js",
);
const { LinuxTargetHelper } = builderRequire(
	"app-builder-lib/out/targets/LinuxTargetHelper.js",
);
const projectDir = resolve(import.meta.dirname, "..");
const configSource = await readFile(
	join(projectDir, "electron-builder.cjs"),
	"utf8",
);
function loadConfig(platform) {
	const module = { exports: {} };
	runInNewContext(configSource, {
		require,
		__dirname: projectDir,
		process: { platform },
		module,
	});
	return module.exports;
}
const config = loadConfig("linux");

test("macOS retains its product name and platform file filters", () => {
	const mac = loadConfig("darwin");
	assert.equal(mac.productName, "Zuse (Beta)");
	assert.ok(mac.linux.files.length > 0);
	assert.equal(config.linux.files, undefined);
});

async function fixture(run) {
	const root = await mkdtemp(join(tmpdir(), "zuse-linux-package-"));
	try {
		const metadata = JSON.parse(
			await readFile(join(projectDir, "package.json"), "utf8"),
		);
		let sequence = 0;
		const info = {
			config,
			metadata,
			tempDirManager: {
				getTempFile: async () => join(root, `script-${sequence++}`),
			},
		};
		const packager = {
			config,
			info,
			projectDir,
			appInfo: new AppInfo(info, undefined, config.linux),
			executableName: config.linux.executableName,
			platformSpecificBuildOptions: config.linux,
			fileAssociations: [],
		};
		const helper = new LinuxTargetHelper(packager);
		const target = new FpmTarget("deb", packager, helper, root);
		await run({ root, packager, helper, scripts: await target.scriptFiles });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("deb install directory and desktop launcher use a space-free path", async () => {
	await fixture(async ({ packager, helper }) => {
		assert.equal(packager.appInfo.sanitizedProductName, "zuse");
		const desktop = await helper.computeDesktopEntry(config.linux);
		assert.match(desktop, /^Exec=\/opt\/zuse\/zuse %U$/m);
		assert.match(desktop, /^Name=Zuse \(Beta\)$/m);
		assert.match(desktop, /x-scheme-handler\/zuse/);
	});
});

async function runScript(root, script, args = [], failure = "") {
	const log = join(root, "commands");
	await writeFile(log, "");
	for (const name of [
		"update-alternatives",
		"chown",
		"chmod",
		"ln",
		"update-mime-database",
		"update-desktop-database",
		"unshare",
	]) {
		await writeFile(
			join(root, name),
			`#!/bin/bash\nprintf '%s' '${name}' >> "$COMMAND_LOG"\nprintf ' <%s>' "$@" >> "$COMMAND_LOG"\nprintf '\\n' >> "$COMMAND_LOG"\nif [ "$FAIL_COMMAND" = 'missing-alternative' ] && [ "$1" = '--remove' ]; then exit 2; fi\n[ "$FAIL_COMMAND" != '${name}' ]\n`,
			{ mode: 0o755 },
		);
	}
	execFileSync("bash", ["-n", script]);
	const result = spawnSync("bash", [script, ...args], {
		env: {
			...process.env,
			PATH: `${root}:${process.env.PATH}`,
			COMMAND_LOG: log,
			FAIL_COMMAND: failure,
		},
		encoding: "utf8",
	});
	return { status: result.status, commands: await readFile(log, "utf8") };
}

test("postinst configures root-owned SUID sandbox even when root can unshare", async () => {
	await fixture(async ({ root, scripts }) => {
		const { status, commands } = await runScript(root, scripts[0], [
			"configure",
		]);
		assert.equal(status, 0);
		assert.match(
			commands,
			/chown <root:root> <\/opt\/zuse\/chrome-sandbox>\nchmod <4755> <\/opt\/zuse\/chrome-sandbox>/,
		);
		assert.match(
			commands,
			/update-alternatives <--remove> <zuse> <\/opt\/Zuse \(Beta\)\/zuse>/,
		);
		assert.match(
			commands,
			/update-alternatives <--install> <\/usr\/bin\/zuse> <zuse> <\/opt\/zuse\/zuse> <100>/,
		);
		assert.doesNotMatch(commands, /unshare|0755|--no-sandbox/);
	});
});

test("postinst fails if sandbox permissions cannot be configured", async () => {
	await fixture(async ({ root, scripts }) => {
		for (const command of ["chown", "chmod"]) {
			const result = await runScript(root, scripts[0], ["configure"], command);
			assert.notEqual(result.status, 0);
		}
	});
});

test("fresh installs and purge tolerate alternatives already being absent", async () => {
	await fixture(async ({ root, scripts }) => {
		for (const script of scripts) {
			const { status } = await runScript(
				root,
				script,
				["purge"],
				"missing-alternative",
			);
			assert.equal(status, 0);
		}
	});
});

test("postrm removes the installed alternative only on removal or purge", async () => {
	await fixture(async ({ root, scripts }) => {
		for (const action of ["remove", "purge", "upgrade"]) {
			const { status, commands } = await runScript(root, scripts[1], [action]);
			assert.equal(status, 0);
			if (action === "upgrade") assert.equal(commands, "");
			else
				assert.match(
					commands,
					/update-alternatives <--remove> <zuse> <\/opt\/zuse\/zuse>/,
				);
		}
	});
});
