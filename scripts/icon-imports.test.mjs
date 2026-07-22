import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const roots = [
	resolve(repoRoot, "apps/renderer/src"),
	resolve(repoRoot, "apps/mobile"),
];
const packagePattern = /@hugeicons-pro\/core-(?:solid|bulk)-rounded/u;
const directPattern =
	/from "(@hugeicons-pro\/core-(?:solid|bulk)-rounded)\/([^"/]+)"/gu;

const sourceFiles = [];
const walk = (directory) => {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (["build", "dist", "node_modules"].includes(entry.name)) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) walk(path);
		else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) sourceFiles.push(path);
	}
};
for (const root of roots) walk(root);

test("icon packages use resolvable per-icon imports", () => {
	for (const file of sourceFiles) {
		const source = readFileSync(file, "utf8");
		for (const line of source.split("\n")) {
			if (!packagePattern.test(line) || line.startsWith("declare module"))
				continue;
			const matches = [...line.matchAll(directPattern)];
			assert.equal(matches.length, 1, `barrel icon import in ${file}: ${line}`);
			const [, packageName, iconName] = matches[0];
			assert.ok(
				existsSync(
					resolve(
						repoRoot,
						"node_modules",
						packageName,
						"dist/esm",
						`${iconName}.js`,
					),
				),
				`missing per-icon export ${packageName}/${iconName} in ${file}`,
			);
		}
	}
});
