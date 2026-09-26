import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifestPath = "apps/server/scripts/toolchain-manifest.json";
const read = (path) => readFileSync(resolve(root, path), "utf8");
const manifest = JSON.parse(read(manifestPath));
const replacements = new Map();
const changes = [];
// Only registry stable releases. Keep the digest-reviewed Grok installer separate.
for (const [name, previous] of Object.entries(manifest.npmPackages)) {
	const version = JSON.parse(
		execFileSync("npm", ["view", `${name}@latest`, "version", "--json"], {
			encoding: "utf8",
			timeout: 60_000,
		}),
	);
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
		throw new Error(`Invalid stable version for ${name}`);
	}
	const oldParts = previous.split(".").map(Number);
	const newParts = version.split(".").map(Number);
	const differing = newParts.findIndex(
		(part, index) => part !== oldParts[index],
	);
	if (differing < 0) continue;
	if (newParts[differing] < oldParts[differing])
		throw new Error(`Refusing downgrade for ${name}`);
	manifest.npmPackages[name] = version;
	changes.push(`${name}: ${previous} → ${version}`);
	const replace = (path, from, to) => {
		const source = replacements.get(path) ?? read(path);
		if (!source.includes(from))
			throw new Error(`Missing expected pin in ${path}: ${from}`);
		replacements.set(path, source.replaceAll(from, to));
	};
	replace(
		"infra/cloud-sandboxes/provision.sh",
		`${name}@${previous}`,
		`${name}@${version}`,
	);
	if (name === "@openai/codex") {
		for (const path of [
			"package.json",
			"packages/contracts/src/cloud-auth.ts",
			"apps/server/test/unit/cloud-runtime-assets.test.ts",
		]) {
			replace(path, `"${previous}"`, `"${version}"`);
		}
	}
}
if (changes.length > 0) {
	const date = new Date().toISOString().slice(0, 10).replaceAll("-", ".");
	const prefix = manifest.version.slice(0, 10);
	const nextDate = date > prefix ? date : prefix;
	manifest.version = `${nextDate}.${nextDate === prefix ? Number(manifest.version.split(".")[3]) + 1 : 1}`;
	replacements.set(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	for (const [path, contents] of replacements)
		writeFileSync(resolve(root, path), contents);
	console.log(changes.join("\n"));
} else {
	console.log("Cloud toolchain is already current.");
}
