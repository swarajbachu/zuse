import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("Ghostty is the only terminal renderer on every supported client", async () => {
	const [
		rendererPackage,
		registry,
		mobileConfig,
		mobileApp,
		androidArchitectures,
		podspec,
		mobileView,
		desktopE2e,
		desktopBuilder,
		version,
	] = await Promise.all([
		read("apps/renderer/package.json"),
		read("apps/renderer/src/lib/terminal-registry.ts"),
		read("apps/mobile/modules/mobile-terminal/expo-module.config.json"),
		read("apps/mobile/app.json"),
		read("apps/mobile/plugins/with-android-architectures.js"),
		read("apps/mobile/modules/mobile-terminal/ZuseMobileTerminal.podspec"),
		read("apps/mobile/modules/mobile-terminal/src/ZuseMobileTerminalView.tsx"),
		read("tests/system/test/desktop/electron-terminal.desktop.test.ts"),
		read("apps/desktop/electron-builder.yml"),
		read("native/libghostty-vt/VERSION"),
	]);

	assert.doesNotMatch(rendererPackage, /@xterm\//);
	assert.doesNotMatch(registry, /@xterm\//);
	assert.doesNotMatch(desktopE2e, /xterm-helper-textarea/);
	assert.match(desktopE2e, /Terminal input/);
	assert.match(desktopBuilder, /native\/libghostty-vt\/LICENSE/);
	assert.match(registry, /ghostty/i);
	assert.deepEqual(JSON.parse(mobileConfig).platforms.sort(), [
		"android",
		"apple",
	]);
	assert.match(mobileApp, /\.\/plugins\/with-android-architectures/);
	assert.match(androidArchitectures, /arm64-v8a,x86_64/);
	assert.doesNotMatch(podspec, /SwiftTerm/);
	assert.doesNotMatch(mobileView, /currently available on iPhone/i);
	assert.equal(version.trim(), "9f62873bf195e4d8a762d768a1405a5f2f7b1697");
});

test("the vendored Ghostty WebAssembly artifact exposes the required ABI", async () => {
	const artifactRoot = "apps/renderer/src/terminal/ghostty/vendor/";
	const [bytes, callback, provenanceText, version, artifactStat, callbackStat] =
		await Promise.all([
			readFile(new URL(`${artifactRoot}ghostty-vt.wasm`, root)),
			readFile(new URL(`${artifactRoot}pty-callback.wasm`, root)),
			read(`${artifactRoot}provenance.json`),
			read("native/libghostty-vt/VERSION"),
			stat(new URL(`${artifactRoot}ghostty-vt.wasm`, root)),
			stat(new URL(`${artifactRoot}pty-callback.wasm`, root)),
		]);
	const provenance = JSON.parse(provenanceText);
	assert.equal(provenanceText, `${JSON.stringify(provenance, null, "\t")}\n`);
	assert.equal(artifactStat.mode & 0o111, 0);
	assert.equal(callbackStat.mode & 0o111, 0);
	const sha256 = (value) => createHash("sha256").update(value).digest("hex");
	assert.deepEqual(provenance, {
		artifacts: {
			"ghostty-vt.wasm": sha256(bytes),
			"pty-callback.wasm": sha256(callback),
		},
		ghosttyRevision: version.trim(),
		jobs: 1,
		optimize: "ReleaseSmall",
		schemaVersion: 1,
		seed: 0,
		target: "wasm32-freestanding",
		zigVersion: "0.15.2",
	});
	assert.ok(bytes.byteLength > 0);
	assert.ok(bytes.byteLength <= 1024 * 1024);
	for (const artifact of [bytes, callback]) {
		assert.equal(artifact.includes(Buffer.from("zuse-ghostty-wasm")), false);
		assert.equal(artifact.includes(Buffer.from("/home/")), false);
	}
	const module = await WebAssembly.compile(bytes);
	const callbackModule = await WebAssembly.compile(callback);
	const exported = new Set(
		WebAssembly.Module.exports(module).map(({ name }) => name),
	);
	for (const name of [
		"memory",
		"ghostty_type_json",
		"ghostty_terminal_new",
		"ghostty_terminal_vt_write",
		"ghostty_terminal_resize",
		"ghostty_render_state_update",
		"ghostty_key_encoder_encode",
		"ghostty_mouse_encoder_encode",
	]) {
		assert.ok(exported.has(name), `missing Ghostty ABI export: ${name}`);
	}
	assert.deepEqual(WebAssembly.Module.exports(callbackModule), [
		{ kind: "memory", name: "memory" },
		{ kind: "function", name: "zuse_ghostty_terminal_reply" },
	]);
	assert.deepEqual(WebAssembly.Module.imports(callbackModule), [
		{ kind: "function", module: "env", name: "zuse_terminal_reply" },
	]);
});

test("the Ghostty WebAssembly build pins Zig's nondeterministic scheduling", async () => {
	const build = await read("scripts/build-ghostty-wasm.mjs");
	assert.match(build, /"build",\s*"--seed",\s*"0"/);
	assert.match(build, /"-j1"/);
	assert.match(build, /"--cache-dir",\s*localCache/);
	assert.match(build, /"--global-cache-dir",\s*globalCache/);
	assert.doesNotMatch(build, /process\.pid/);
	assert.match(
		build,
		/finally[\s\S]*rmSync\(localCache[\s\S]*rmSync\(globalCache[\s\S]*releaseBootstrap\(\)/,
	);
});
