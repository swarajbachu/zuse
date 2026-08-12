import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { detectIconMode, getPaidIconAliases } = require("./icon-runtime.cjs");

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedModeArgument = process.argv.find((argument) =>
	argument.startsWith("--expect="),
);
const expectedMode = expectedModeArgument?.slice("--expect=".length);
if (expectedMode && expectedMode !== "free" && expectedMode !== "paid") {
	throw new Error(`Unknown icon mode ${JSON.stringify(expectedMode)}.`);
}

const actualMode = detectIconMode();
if (expectedMode && actualMode !== expectedMode) {
	throw new Error(
		`Expected ${expectedMode} icons, but detected ${actualMode}.`,
	);
}

const typeScriptFiles = (directory) =>
	readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) return typeScriptFiles(path);
		return entry.isFile() && /\.tsx?$/.test(entry.name) ? [path] : [];
	});

const sourceFiles = [
	"apps/renderer/src",
	"apps/mobile/app",
	"apps/mobile/src",
].flatMap((directory) => typeScriptFiles(resolve(workspaceRoot, directory)));

const iconImports = new Map();
const importPattern =
	/import\s*\{([^}]*)\}\s*from\s*["'](@zuse\/icons\/(?:bulk|solid|stroke)-rounded)["']/g;

const sources = sourceFiles.map((path) => [path, readFileSync(path, "utf8")]);
for (const [, source] of sources) {
	for (const match of source.matchAll(importPattern)) {
		const moduleName = match[2];
		const names = iconImports.get(moduleName) ?? new Set();
		for (const imported of match[1].split(",")) {
			const name = imported
				.trim()
				.replace(/^type\s+/, "")
				.split(/\s+as\s+/)[0];
			if (name) names.add(name);
		}
		iconImports.set(moduleName, names);
	}
}

if (iconImports.size === 0) {
	throw new Error("No application imports use the @zuse/icons facade.");
}

const privateImports = sources
	.filter(([, source]) => source.includes("@hugeicons-pro/"))
	.map(([path]) => path);
if (privateImports.length > 0) {
	throw new Error(
		`Application code imports licensed packages directly:\n${privateImports.join("\n")}`,
	);
}

const rootLock = readFileSync(resolve(workspaceRoot, "bun.lock"), "utf8");
if (rootLock.includes("npm.hugeicons.com")) {
	throw new Error("The root lockfile still contains licensed icon tarballs.");
}

const paidAliases = actualMode === "paid" ? getPaidIconAliases() : {};
for (const [moduleName, importedNames] of iconImports) {
	const modulePath = paidAliases[moduleName];
	const iconModule = modulePath
		? await import(pathToFileURL(modulePath).href)
		: await import(moduleName);
	const missing = [...importedNames].filter((name) => !(name in iconModule));
	if (missing.length > 0) {
		throw new Error(`${moduleName} is missing exports: ${missing.join(", ")}`);
	}
}

console.log(`Icon mode: ${actualMode}. Import contract verified.`);
