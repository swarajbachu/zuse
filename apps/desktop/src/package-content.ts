const REQUIRED_RUNTIME_ENTRIES = [
	"/dist-electron/app-mcp-proxy-child.cjs",
	"/dist-electron/browser-mcp-child.cjs",
	"/dist-electron/linear-mcp-child.cjs",
	"/dist-electron/main.cjs",
	"/dist-electron/orchestration-mcp-child.cjs",
	"/dist-electron/preload.cjs",
	"/dist-electron/ssh-bridge-child.cjs",
	"/node_modules/@cursor/sdk/dist/cjs/index.js",
	"/node_modules/@cursor/sdk/dist/cjs/sqlite.js",
	"/node_modules/@cursor/sdk/package.json",
	"/node_modules/@cursor/sdk/node_modules/@cursor/sdk-linux-x64/bin/cursorsandbox",
	"/node_modules/@cursor/sdk/node_modules/@cursor/sdk-linux-x64/bin/rg",
	"/node_modules/@cursor/sdk/node_modules/@cursor/sdk-linux-x64/package.json",
	"/node_modules/keytar/build/Release/keytar.node",
	"/node_modules/node-pty/build/Release/pty.node",
	"/node_modules/node-pty/lib/eventEmitter2.js",
	"/node_modules/node-pty/lib/index.js",
	"/node_modules/node-pty/lib/terminal.js",
	"/node_modules/node-pty/lib/unixTerminal.js",
	"/node_modules/node-pty/lib/utils.js",
	"/node_modules/node-pty/package.json",
	"/node_modules/tree-sitter/index.js",
	"/node_modules/tree-sitter/package.json",
	"/node_modules/tree-sitter-javascript/bindings/node/index.js",
	"/node_modules/tree-sitter-javascript/package.json",
	"/node_modules/tree-sitter-javascript/prebuilds/linux-x64/tree-sitter-javascript.node",
	"/node_modules/tree-sitter-javascript/src/node-types.json",
	"/node_modules/tree-sitter-json/prebuilds/linux-x64/tree-sitter-json.node",
	"/node_modules/tree-sitter-json/bindings/node/index.js",
	"/node_modules/tree-sitter-json/package.json",
	"/node_modules/tree-sitter-json/src/node-types.json",
	"/node_modules/tree-sitter-typescript/bindings/node/index.js",
	"/node_modules/tree-sitter-typescript/bindings/node/tsx.js",
	"/node_modules/tree-sitter-typescript/bindings/node/typescript.js",
	"/node_modules/tree-sitter-typescript/package.json",
	"/node_modules/tree-sitter-typescript/prebuilds/linux-x64/tree-sitter-typescript.node",
	"/node_modules/tree-sitter-typescript/tsx/src/node-types.json",
	"/node_modules/tree-sitter-typescript/tsx/package.json",
	"/node_modules/tree-sitter-typescript/typescript/src/node-types.json",
	"/node_modules/tree-sitter-typescript/typescript/package.json",
	"/node_modules/tree-sitter/prebuilds/linux-x64/tree-sitter.node",
	"/package.json",
] as const;

const DECLARATION_OR_SOURCE_EXTENSION = /\.(?:cts|mts|ts|tsx)$/u;
const NON_LINUX_X64_PREBUILD = /\/prebuilds\/(?!linux-x64(?:\/|$))[^/]+/u;
const NON_LINUX_X64_CURSOR_SDK =
	/\/node_modules\/@cursor\/sdk-(?!linux-x64(?:\/|$))[^/]+/u;
const LINUX_RUNTIME_UNUSED_VENDOR_ENTRY_PATTERNS = [
	/\/node_modules\/@cursor\/sdk\/dist\/esm(?:\/|$)/u,
	/\/node_modules\/node-pty\/(?:binding\.gyp|deps\/|scripts\/|src\/|typings\/|node_modules\/node-addon-api\/|build\/(?!Release(?:\/|$)))/u,
	/\/node_modules\/node-pty\/lib\/(?:.*\/)?[^/]+\.test\.js/u,
	/\/node_modules\/tree-sitter-(?:javascript|json)\/(?:binding\.gyp|grammar\.js|tree-sitter-(?:javascript|json)\.wasm|bindings\/node\/binding_test\.js|src\/(?:grammar\.json|parser\.c|scanner\.c|tree_sitter\/))/u,
	/\/node_modules\/tree-sitter-typescript\/(?:binding\.gyp|common\/|tree-sitter-(?:tsx|typescript)\.wasm|bindings\/node\/binding_test\.js|(?:tsx|typescript)\/grammar\.js|(?:tsx|typescript)\/src\/(?:grammar\.json|parser\.c|scanner\.c|tree_sitter\/))/u,
] as const;

export const validateDesktopMainBundle = (source: string): void => {
	if (!source.includes('require("@cursor/sdk")')) {
		throw new Error(
			"Desktop main bundle must load the packaged Cursor SDK through CommonJS",
		);
	}
	if (/\bimport\(\s*["']@cursor\/sdk["']\s*\)/u.test(source)) {
		throw new Error(
			"Desktop main bundle cannot import the pruned Cursor SDK ESM entry",
		);
	}
};

export const validateDesktopPackageEntries = (
	entries: ReadonlyArray<string>,
): void => {
	const entrySet = new Set(entries);
	const declarationsOrSources = entries.filter((entry) =>
		DECLARATION_OR_SOURCE_EXTENSION.test(entry),
	);
	if (declarationsOrSources.length > 0) {
		throw new Error(
			`Desktop package contains TypeScript-only files:\n${declarationsOrSources.join("\n")}`,
		);
	}
	const wrongPlatformNativeEntries = entries.filter(
		(entry) =>
			NON_LINUX_X64_PREBUILD.test(entry) ||
			NON_LINUX_X64_CURSOR_SDK.test(entry),
	);
	if (wrongPlatformNativeEntries.length > 0) {
		throw new Error(
			`Linux x64 package contains wrong-platform native entries:\n${wrongPlatformNativeEntries.join("\n")}`,
		);
	}
	const unusedVendorEntries = entries.filter((entry) =>
		LINUX_RUNTIME_UNUSED_VENDOR_ENTRY_PATTERNS.some((pattern) =>
			pattern.test(entry),
		),
	);
	if (unusedVendorEntries.length > 0) {
		throw new Error(
			`Linux package contains build-time vendor entries:\n${unusedVendorEntries.join("\n")}`,
		);
	}

	const missingRuntimeEntries = REQUIRED_RUNTIME_ENTRIES.filter(
		(entry) => !entrySet.has(entry),
	);
	if (missingRuntimeEntries.length > 0) {
		throw new Error(
			`Desktop package is missing runtime entries:\n${missingRuntimeEntries.join("\n")}`,
		);
	}

	if (!entries.some((entry) => entry.endsWith(".mjs"))) {
		throw new Error(
			"Desktop package has no runtime MJS entry; the TypeScript exclusion may be too broad",
		);
	}
};
