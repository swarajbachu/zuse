// Codegen: bake the Material Icon Theme file-icon SVGs (and the filename /
// extension → icon-name lookup maps) into a single TypeScript module the mobile
// app can render synchronously via react-native-svg's <SvgXml>. We only emit the
// FILE icon subset actually reachable from the manifest (folders aren't shown in
// chat), so the bundle stays bounded.
//
// Run: `bun run gen:file-icons` (from apps/mobile). The output is committed.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const manifestPath = require.resolve(
	"material-icon-theme/dist/material-icons.json",
);
const manifestDir = dirname(manifestPath);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// Keep in sync with EXTRA_EXTENSIONS in packages/file-icons: these icon names
// must be present in ICON_XML so the runtime resolver can reach them.
const EXTRA_ICON_NAMES = [
	"typescript",
	"react_ts",
	"javascript",
	"react",
	"html",
	"yaml",
];

/** Every icon name the file resolver can return. */
const reachable = new Set();
for (const name of Object.values(manifest.fileNames)) reachable.add(name);
for (const name of Object.values(manifest.fileExtensions)) reachable.add(name);
for (const name of EXTRA_ICON_NAMES) reachable.add(name);
reachable.add(manifest.file);

const cleanSvg = (svg) =>
	svg
		.replace(/<\?xml[^>]*\?>/g, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/\s+/g, " ")
		.trim();

const xmlByName = {};
let missing = 0;
for (const name of [...reachable].sort()) {
	const def = manifest.iconDefinitions[name];
	if (def === undefined) {
		missing += 1;
		continue;
	}
	try {
		const svg = readFileSync(resolve(manifestDir, def.iconPath), "utf8");
		xmlByName[name] = cleanSvg(svg);
	} catch {
		missing += 1;
	}
}

const json = (value) => JSON.stringify(value);

const iconEntries = Object.keys(xmlByName)
	.sort()
	.map((name) => `\t${json(name)}: ${json(xmlByName[name])},`)
	.join("\n");

const output = `// GENERATED FILE — do not edit by hand.
// Run \`bun run gen:file-icons\` (apps/mobile) to regenerate from material-icon-theme.
// Source of truth for resolution logic: ~/lib/icons/resolve.

import type { IconLookup } from "./resolve";

export const FILE_ICON_LOOKUP: IconLookup = {
\tfileNames: ${json(manifest.fileNames)},
\tfileExtensions: ${json(manifest.fileExtensions)},
\tdefaultFile: ${json(manifest.file)},
};

export const ICON_XML: Record<string, string> = {
${iconEntries}
};
`;

const outPath = resolve(
	here,
	"../src/lib/icons/material-icon-xml.generated.ts",
);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, output);

console.log(
	`gen:file-icons → ${Object.keys(xmlByName).length} icons` +
		` (${missing} missing) → ${outPath}`,
);
