// Codegen: turn the structured file tree's built-in SVG sprite into a small
// React Native lookup. Mobile and desktop then resolve the same file name to
// the same glyph without shipping a second icon package in the app bundle.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createFileTreeIconResolver,
	getBuiltInSpriteSheet,
} from "@pierre/trees";

const here = dirname(fileURLToPath(import.meta.url));
const packageEntry = fileURLToPath(import.meta.resolve("@pierre/trees"));
const builtInSource = readFileSync(
	resolve(dirname(packageEntry), "builtInIcons.js"),
	"utf8",
);
const resolver = createFileTreeIconResolver("complete");

const objectKeys = (name) => {
	const block = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(
		builtInSource,
	)?.[1];
	if (block === undefined) throw new Error(`Could not find ${name}`);
	return [...block.matchAll(/^\s*(?:"([^"]+)"|([\w-]+)):\s*"[^"]+",?$/gm)].map(
		(match) => match[1] ?? match[2],
	);
};

const resolveToken = (fileName) =>
	resolver.resolveIcon("file-tree-icon-file", fileName).token ?? "default";

const fileNames = Object.fromEntries(
	objectKeys("BUILT_IN_FILE_NAME_TOKENS").map((name) => [
		name.toLowerCase(),
		resolveToken(name),
	]),
);
const extensions = Object.fromEntries(
	objectKeys("BUILT_IN_FILE_EXTENSION_TOKENS").map((extension) => [
		extension.toLowerCase(),
		resolveToken(`file.${extension}`),
	]),
);

const sprite = getBuiltInSpriteSheet("complete");
const icons = {};
for (const match of sprite.matchAll(
	/<symbol id="file-tree-builtin-([^"]+)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/g,
)) {
	const [, token, viewBox, body] = match;
	icons[token] = `<svg viewBox="${viewBox}">${body.trim()}</svg>`;
}

const output = `// GENERATED FILE — do not edit by hand.
// Run \`bun run gen:file-icons\` (apps/mobile) to regenerate.
// The source glyphs and resolution rules come from the structured file tree.

export const FILE_ICON_FILE_NAMES: Readonly<Record<string, string>> = ${JSON.stringify(fileNames)};
export const FILE_ICON_EXTENSIONS: Readonly<Record<string, string>> = ${JSON.stringify(extensions)};
export const FILE_ICON_XML: Readonly<Record<string, string>> = ${JSON.stringify(icons)};
`;

const outPath = resolve(here, "../src/lib/icons/file-icons.generated.ts");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, output);
console.log(
	`gen:file-icons → ${Object.keys(icons).length} shared glyphs → ${outPath}`,
);
