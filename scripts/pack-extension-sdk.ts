import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "packages/extension-sdk");
const target = join(root, ".context/sdk-release");
await mkdir(target, { recursive: true });
await rm(join(target, "dist"), { recursive: true, force: true });
await cp(join(source, "dist"), join(target, "dist"), { recursive: true });
const manifest = JSON.parse(
	await readFile(join(source, "package.json"), "utf8"),
);
const catalog = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
	.workspaces.catalog;
for (const [key, value] of Object.entries(manifest.dependencies))
	if (value === "catalog:") manifest.dependencies[key] = catalog[key];
manifest.exports = Object.fromEntries(
	["index", "client", "server", "host"].map((name) => [
		name === "index" ? "." : `./${name}`,
		{ types: `./dist/${name}.d.mts`, import: `./dist/${name}.mjs` },
	]),
);
delete manifest.devDependencies;
delete manifest.scripts;
await writeFile(
	join(target, "package.json"),
	`${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(
	`Publishable SDK staged at ${target}. Run npm pack there; publication requires release credentials.`,
);
