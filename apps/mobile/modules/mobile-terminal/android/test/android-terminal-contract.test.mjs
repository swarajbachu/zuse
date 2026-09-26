import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

const moduleRoot = new URL("../", import.meta.url);
const repositoryRoot = new URL("../../../../../", moduleRoot);
const readModule = (path) => readFile(new URL(path, moduleRoot), "utf8");
const readRepository = (path) =>
	readFile(new URL(path, repositoryRoot), "utf8");
const treeSha256 = async (relativeDirectory) => {
	const files = [];
	const visit = async (directory, prefix) => {
		const entries = await readdir(directory, { withFileTypes: true });
		await Promise.all(
			entries.map(async (entry) => {
				const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
				const url = new URL(entry.name, directory);
				if (entry.isDirectory()) {
					await visit(new URL(`${entry.name}/`, directory), relative);
				} else if (entry.isFile()) {
					files.push([
						relative,
						createHash("sha256")
							.update(await readFile(url))
							.digest("hex"),
					]);
				}
			}),
		);
	};
	await visit(new URL(relativeDirectory, moduleRoot), "");
	files.sort(([left], [right]) => left.localeCompare(right));
	return createHash("sha256").update(JSON.stringify(files)).digest("hex");
};

test("Android and Apple resolve the shared registered terminal view", async () => {
	const [config, nativeView, module] = await Promise.all([
		readRepository(
			"apps/mobile/modules/mobile-terminal/expo-module.config.json",
		),
		readRepository(
			"apps/mobile/modules/mobile-terminal/src/ZuseMobileTerminalView.tsx",
		),
		readModule(
			"src/main/java/com/zuse/mobileterminal/ZuseMobileTerminalModule.kt",
		),
	]);

	assert.deepEqual(JSON.parse(config).platforms.sort(), ["android", "apple"]);
	assert.match(
		nativeView,
		/requireNativeViewManager\(\s*"ZuseMobileTerminal"\s*\)/,
		"both native platforms must resolve the module's registered default view",
	);
	assert.doesNotMatch(
		nativeView,
		/requireNativeViewManager\(\s*"ZuseMobileTerminal"\s*,/,
		"a named lookup must not drift from the native View definition",
	);
	assert.doesNotMatch(nativeView, /currently available on iPhone/i);
	for (const event of ["onInput", "onResize", "onOpenLink"]) {
		assert.match(module, new RegExp(event));
	}
	for (const prop of ["feed", "fontSize", "focusNonce", "controlNonce"]) {
		assert.match(module, new RegExp(`Prop\\(\\"${prop}\\"`));
	}
});

test("Android builds and links Ghostty from the repository provenance pin", async () => {
	const [
		version,
		upstreamLicense,
		packagedLicense,
		buildScript,
		bootstrap,
		gradle,
		cmake,
		exports,
		bridge,
	] = await Promise.all([
		readRepository("native/libghostty-vt/VERSION"),
		readRepository("native/libghostty-vt/LICENSE"),
		readModule("src/main/assets/licenses/libghostty-vt.txt"),
		readModule("scripts/build-ghostty-android.mjs"),
		readRepository("scripts/lib/ghostty-build-bootstrap.mjs"),
		readModule("build.gradle"),
		readModule("src/main/cpp/CMakeLists.txt"),
		readModule("src/main/cpp/zuse_terminal.map"),
		readModule("src/main/cpp/zuse_terminal_jni.cpp"),
	]);

	assert.equal(version.trim(), "9f62873bf195e4d8a762d768a1405a5f2f7b1697");
	assert.equal(packagedLicense, upstreamLicense);
	const supplyChain = `${buildScript}\n${bootstrap}`;
	assert.match(buildScript, /native\/libghostty-vt\/VERSION/);
	assert.match(buildScript, /path\.join\(provenanceRoot, "LICENSE"\)/);
	assert.match(supplyChain, /rev-parse/);
	assert.match(supplyChain, /0\.15\.2/);
	assert.match(supplyChain, /createHash\("sha256"\)/);
	assert.match(supplyChain, /ZUSE-INTEGRITY\.json/);
	assert.match(supplyChain, /archiveSha256/);
	assert.match(supplyChain, /binarySha256/);
	assert.match(supplyChain, /remote[\s\S]*get-url[\s\S]*origin/);
	assert.match(supplyChain, /"rev-parse"[\s\S]*"FETCH_HEAD"/);
	assert.match(buildScript, /artifacts/);
	assert.match(buildScript, /artifactIsVerified/);
	assert.match(buildScript, /-Dsimd=false/);
	assert.match(buildScript, /aarch64-linux-android\.\$\{androidApi\}/);
	assert.match(buildScript, /x86_64-linux-android\.\$\{androidApi\}/);
	assert.match(buildScript, /buildRecipeVersion/);
	assert.match(buildScript, /"--seed",\s*"0"/);
	assert.match(buildScript, /"--global-cache-dir"/);
	assert.match(buildScript, /libghostty_vt_shared\.install/);
	assert.match(buildScript, /zuse-ghostty-android-source-/);
	assert.match(buildScript, /zuse-ghostty-android-build-/);
	assert.match(buildScript, /27\.1\.12297006/);
	assert.match(buildScript, /ANDROID_NDK_HOME: deterministicPaths\.ndk/);
	assert.match(buildScript, /arm64-v8a/);
	assert.match(buildScript, /x86_64/);
	assert.doesNotMatch(buildScript, /armeabi-v7a/);
	assert.match(gradle, /unsupportedArchitectures/);
	assert.match(gradle, /reactNativeArchitectures=arm64-v8a,x86_64/);
	assert.match(gradle, /ndkVersion rootProject\.ext\.ndkVersion/);
	assert.match(
		gradle,
		/inputs\.file\(new File\(repositoryRoot, 'scripts\/lib\/ghostty-build-bootstrap\.mjs'\)\)/,
	);
	assert.match(cmake, /libghostty-vt\.a/);
	assert.match(cmake, /zuse_terminal_jni\.cpp/);
	assert.match(cmake, /--version-script/);
	assert.match(
		exports,
		/Java_com_zuse_mobileterminal_GhosttyTerminalNative_\*/,
	);
	assert.match(exports, /local:\s*\*/);
	for (const symbol of [
		"ghostty_terminal_new",
		"ghostty_terminal_vt_write",
		"ghostty_terminal_resize",
		"ghostty_render_state_update",
		"ghostty_key_encoder_encode",
	]) {
		assert.match(bridge, new RegExp(symbol));
	}
});

test("the checked-in Android artifacts have complete, verified provenance", async () => {
	for (const artifact of [
		"apps/mobile/modules/mobile-terminal/android/vendor/manifest.json",
		"apps/mobile/modules/mobile-terminal/android/vendor/LICENSE",
		"apps/mobile/modules/mobile-terminal/android/vendor/REVISION",
		"apps/mobile/modules/mobile-terminal/android/vendor/include/ghostty/vt.h",
		"apps/mobile/modules/mobile-terminal/android/vendor/lib/arm64-v8a/libghostty-vt.a",
		"apps/mobile/modules/mobile-terminal/android/vendor/lib/x86_64/libghostty-vt.a",
	]) {
		const ignored = spawnSync(
			"git",
			["check-ignore", "--no-index", "-q", "--", artifact],
			{ cwd: repositoryRoot },
		);
		assert.equal(
			ignored.status,
			1,
			`${artifact} must be included in a fresh checkout`,
		);
	}
	const [manifestText, revision, license, headers, arm64, x86_64] =
		await Promise.all([
			readModule("vendor/manifest.json"),
			readRepository("native/libghostty-vt/VERSION"),
			readModule("vendor/LICENSE"),
			treeSha256("vendor/include/"),
			readFile(new URL("vendor/lib/arm64-v8a/libghostty-vt.a", moduleRoot)),
			readFile(new URL("vendor/lib/x86_64/libghostty-vt.a", moduleRoot)),
		]);
	const sha256 = (value) => createHash("sha256").update(value).digest("hex");
	const manifest = JSON.parse(manifestText);
	assert.equal(manifestText, `${JSON.stringify(manifest, null, "\t")}\n`);
	for (const [abi, archive] of [
		["arm64-v8a", arm64],
		["x86_64", x86_64],
	]) {
		for (const hostPath of ["/home/", "/Users/", ".cache/zig"]) {
			assert.equal(
				archive.includes(Buffer.from(hostPath)),
				false,
				`${abi} embeds host-specific path ${hostPath}`,
			);
		}
	}

	assert.deepEqual(manifest, {
		androidApi: 24,
		artifacts: {
			"include/**": headers,
			"lib/arm64-v8a/libghostty-vt.a": sha256(arm64),
			"lib/x86_64/libghostty-vt.a": sha256(x86_64),
			LICENSE: sha256(license),
		},
		abis: ["arm64-v8a", "x86_64"],
		buildHost: "x86_64-linux",
		buildRecipeVersion: 4,
		deterministicPaths: {
			globalCache: "/tmp/zuse-ghostty-android-zig-global-9f62873b",
			ndk: "/tmp/zuse-ghostty-android-ndk-27.1.12297006",
			output: "/tmp/zuse-ghostty-android-build-9f62873b",
			source: "/tmp/zuse-ghostty-android-source-9f62873b",
			zig: "/tmp/zuse-ghostty-android-zig-0.15.2",
		},
		ndkVersion: "27.1.12297006",
		revision: revision.trim(),
		seed: 0,
		simd: false,
		zigArchiveSha256:
			"02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239",
		zigBinarySha256:
			"2858dc89dbbfdd08cceda1b841e7fd0a793a1a67b49f150bc3d0d1de44ed7f51",
		zigDistribution: "zig-x86_64-linux-0.15.2.tar.xz",
		zigVersion: "0.15.2",
	});
});

test("the JNI seam covers rendering, IME, scrolling, selection, and links", async () => {
	const [nativeInterface, view, bridge, smokeTest] = await Promise.all([
		readModule(
			"src/main/java/com/zuse/mobileterminal/GhosttyTerminalNative.kt",
		),
		readModule("src/main/java/com/zuse/mobileterminal/GhosttyTerminalView.kt"),
		readModule("src/main/cpp/zuse_terminal_jni.cpp"),
		readModule(
			"src/androidTest/java/com/zuse/mobileterminal/GhosttyNativeSmokeTest.kt",
		),
	]);

	for (const operation of [
		"create",
		"destroy",
		"feed",
		"resize",
		"render",
		"encodeKey",
		"scroll",
		"select",
		"selectedText",
		"linkAt",
	]) {
		assert.match(nativeInterface, new RegExp(operation));
	}
	assert.match(view, /BaseInputConnection/);
	assert.match(view, /onDraw/);
	assert.match(view, /GestureDetector/);
	assert.match(view, /onOpenLink/);
	assert.match(view, /blinkInvalidationScheduled/);
	assert.match(bridge, /ghostty_grid_ref_hyperlink_uri/);
	assert.match(bridge, /ghostty_terminal_selection_format_buf/);
	assert.match(bridge, /kMaxPtyResponseBytes/);
	for (const operation of [
		"revision",
		"feed",
		"render",
		"linkAt",
		"select",
		"encodeKey",
		"resize",
	]) {
		assert.match(smokeTest, new RegExp(operation));
	}
});
