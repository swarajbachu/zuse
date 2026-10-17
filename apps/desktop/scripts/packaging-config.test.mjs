import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

test("Windows installer configuration parses without conflicting platform keys", () => {
	const config = parse(
		readFileSync(
			new URL("../electron-builder.base.yml", import.meta.url),
			"utf8",
		),
	);
	assert.deepEqual(config.win.target, [{ target: "nsis", arch: "x64" }]);
	assert.equal(config.win.executableName, "Zuse");
	assert.ok(config.win.files.length > 0, "Keep native platform pruning");
	assert.equal(config.nsis.oneClick, false);
	assert.equal(config.nsis.deleteAppDataOnUninstall, false);
	assert.equal(config.nsis.createDesktopShortcut, "always");
	assert.equal(config.nsis.createStartMenuShortcut, true);
});
