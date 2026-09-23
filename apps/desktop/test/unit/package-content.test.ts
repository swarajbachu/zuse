import { readFile } from "node:fs/promises";
import Path from "node:path";
import { describe, expect, it } from "vitest";

import {
	validateDesktopMainBundle,
	validateDesktopPackageEntries,
} from "../../src/package-content.ts";

const requiredRuntimeEntries = [
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
	"/node_modules/runtime/index.mjs",
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

describe("desktop package content", () => {
	it("keeps required CJS and MJS runtime entries", () => {
		expect(() =>
			validateDesktopPackageEntries(requiredRuntimeEntries),
		).not.toThrow();
	});

	it.each([
		"main.d.cts",
		"runtime.mts",
		"source.ts",
		"view.tsx",
	])("rejects TypeScript-only package entry %s", (entry) => {
		expect(() =>
			validateDesktopPackageEntries([...requiredRuntimeEntries, `/${entry}`]),
		).toThrow("Desktop package contains TypeScript-only files");
	});

	it.each([
		"darwin-arm64",
		"darwin-x64",
		"linux-arm64",
		"win32-x64",
	])("rejects wrong-platform native prebuild %s", (platform) => {
		expect(() =>
			validateDesktopPackageEntries([
				...requiredRuntimeEntries,
				`/node_modules/native/prebuilds/${platform}/native.node`,
			]),
		).toThrow("Linux x64 package contains wrong-platform native entries");
	});

	it.each([
		"darwin-arm64",
		"darwin-x64",
		"linux-arm64",
		"win32-x64",
	])("rejects wrong-platform Cursor SDK %s", (platform) => {
		expect(() =>
			validateDesktopPackageEntries([
				...requiredRuntimeEntries,
				`/node_modules/@cursor/sdk/node_modules/@cursor/sdk-${platform}/bin/agent`,
			]),
		).toThrow("Linux x64 package contains wrong-platform native entries");
	});

	it.each([
		"/node_modules/@cursor/sdk/dist/esm/index.js",
		"/node_modules/node-pty/deps/winpty/Makefile",
		"/node_modules/node-pty/lib/terminal.test.js",
		"/node_modules/node-pty/node_modules/node-addon-api/napi.h",
		"/node_modules/tree-sitter-javascript/src/parser.c",
		"/node_modules/tree-sitter-javascript/grammar.js",
		"/node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm",
		"/node_modules/tree-sitter-json/src/parser.c",
		"/node_modules/tree-sitter-json/tree-sitter-json.wasm",
		"/node_modules/tree-sitter-typescript/common/define-grammar.js",
		"/node_modules/tree-sitter-typescript/tsx/src/parser.c",
		"/node_modules/tree-sitter-typescript/typescript/grammar.js",
		"/node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm",
	])("rejects build-time vendor entry %s", (entry) => {
		expect(() =>
			validateDesktopPackageEntries([...requiredRuntimeEntries, entry]),
		).toThrow("Linux package contains build-time vendor entries");
	});

	it("requires the Cursor SDK CommonJS entry in the desktop bundle", () => {
		expect(() =>
			validateDesktopMainBundle('const sdk = require("@cursor/sdk");'),
		).not.toThrow();
		expect(() =>
			validateDesktopMainBundle('await import("@cursor/sdk");'),
		).toThrow("must load the packaged Cursor SDK through CommonJS");
		expect(() =>
			validateDesktopMainBundle(
				'const sdk = require("@cursor/sdk"); await import("@cursor/sdk");',
			),
		).toThrow("cannot import the pruned Cursor SDK ESM entry");
	});

	it("keeps the builder exclusion aligned with the package content guard", async () => {
		const builderConfiguration = await readFile(
			Path.resolve(import.meta.dirname, "../../electron-builder.base.yml"),
			"utf8",
		);
		expect(builderConfiguration).toContain("!**/*.{ts,tsx,cts,mts,map,md}");
		expect(builderConfiguration).toContain(
			"!node_modules/{node-pty,tree-sitter,tree-sitter-javascript,tree-sitter-json,tree-sitter-typescript}/prebuilds/{darwin-*,linux-arm64,win32-*}/**",
		);
		expect(builderConfiguration).toContain(
			"!node_modules/**/@cursor/sdk-{darwin-*,linux-arm64,win32-*}/**",
		);
		expect(builderConfiguration).toContain(
			"!node_modules/tree-sitter-{javascript,json}/src/{grammar.json,parser.c,scanner.c,tree_sitter/**}",
		);
		expect(builderConfiguration).toContain(
			"!node_modules/tree-sitter-typescript/{typescript,tsx}/src/{grammar.json,parser.c,scanner.c,tree_sitter/**}",
		);
		expect(builderConfiguration).toContain(
			"!node_modules/@cursor/sdk/dist/esm/**",
		);
		expect(builderConfiguration).toContain(
			"!node_modules/node-pty/{src,scripts,deps,typings}/**",
		);
		expect(builderConfiguration).toContain(
			"to: app/licenses/Cursor-SDK.LICENSE.md",
		);
	});
});
