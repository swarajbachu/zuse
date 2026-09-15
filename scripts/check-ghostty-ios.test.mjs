import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const vendorRoot = path.join(
	repository,
	"apps/mobile/modules/mobile-terminal/Vendor",
);
const framework = path.join(vendorRoot, "GhosttyVt.xcframework");
const iosModule = path.join(
	repository,
	"apps/mobile/modules/mobile-terminal/ios",
);
const revision = readFileSync(
	path.join(repository, "native/libghostty-vt/VERSION"),
	"utf8",
).trim();
const provenanceText = readFileSync(
	path.join(vendorRoot, "GhosttyVt.provenance.json"),
	"utf8",
);
const provenance = JSON.parse(provenanceText);
const slices = ["ios-arm64", "ios-arm64_x86_64-simulator"];
const requiredSymbols = [
	"_ghostty_cell_get",
	"_ghostty_focus_encode",
	"_ghostty_grid_ref_hyperlink_uri",
	"_ghostty_key_encoder_encode",
	"_ghostty_key_encoder_free",
	"_ghostty_key_encoder_new",
	"_ghostty_key_encoder_setopt_from_terminal",
	"_ghostty_key_event_free",
	"_ghostty_key_event_new",
	"_ghostty_key_event_set_action",
	"_ghostty_key_event_set_composing",
	"_ghostty_key_event_set_consumed_mods",
	"_ghostty_key_event_set_key",
	"_ghostty_key_event_set_mods",
	"_ghostty_key_event_set_unshifted_codepoint",
	"_ghostty_key_event_set_utf8",
	"_ghostty_mouse_encoder_encode",
	"_ghostty_mouse_encoder_free",
	"_ghostty_mouse_encoder_new",
	"_ghostty_mouse_encoder_reset",
	"_ghostty_mouse_encoder_setopt",
	"_ghostty_mouse_encoder_setopt_from_terminal",
	"_ghostty_mouse_event_clear_button",
	"_ghostty_mouse_event_free",
	"_ghostty_mouse_event_new",
	"_ghostty_mouse_event_set_action",
	"_ghostty_mouse_event_set_button",
	"_ghostty_mouse_event_set_mods",
	"_ghostty_mouse_event_set_position",
	"_ghostty_paste_encode",
	"_ghostty_render_state_free",
	"_ghostty_render_state_get",
	"_ghostty_terminal_new",
	"_ghostty_render_state_new",
	"_ghostty_render_state_row_cells_free",
	"_ghostty_render_state_row_cells_get",
	"_ghostty_render_state_row_cells_new",
	"_ghostty_render_state_row_cells_next",
	"_ghostty_render_state_row_get",
	"_ghostty_render_state_row_iterator_free",
	"_ghostty_render_state_row_iterator_new",
	"_ghostty_render_state_row_iterator_next",
	"_ghostty_render_state_row_set",
	"_ghostty_render_state_set",
	"_ghostty_render_state_update",
	"_ghostty_selection_gesture_event",
	"_ghostty_selection_gesture_event_free",
	"_ghostty_selection_gesture_event_new",
	"_ghostty_selection_gesture_event_set",
	"_ghostty_selection_gesture_free",
	"_ghostty_selection_gesture_new",
	"_ghostty_selection_gesture_reset",
	"_ghostty_style_default",
	"_ghostty_terminal_free",
	"_ghostty_terminal_grid_ref",
	"_ghostty_terminal_mode_get",
	"_ghostty_terminal_reset",
	"_ghostty_terminal_resize",
	"_ghostty_terminal_scroll_viewport",
	"_ghostty_terminal_select_all",
	"_ghostty_terminal_select_line",
	"_ghostty_terminal_select_word",
	"_ghostty_terminal_selection_format_buf",
	"_ghostty_terminal_set",
	"_ghostty_terminal_vt_write",
];

const cpuNames = new Map([
	[0x01000007, "x86_64"],
	[0x0100000c, "arm64"],
]);

function encodedVersion(value) {
	const major = value >>> 16;
	const minor = (value >>> 8) & 0xff;
	const patch = value & 0xff;
	return patch === 0 ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
}

function readMachObject(bytes, artifact) {
	assert.equal(bytes.readUInt32LE(0), 0xfeedfacf, "expected Mach-O 64 object");
	const cpu = cpuNames.get(bytes.readUInt32LE(4));
	assert.ok(cpu, "unsupported Mach-O CPU type");
	artifact.architectures.add(cpu);
	const commands = bytes.readUInt32LE(16);
	let commandOffset = 32;
	let symbolTable;
	for (let index = 0; index < commands; index += 1) {
		const command = bytes.readUInt32LE(commandOffset);
		const size = bytes.readUInt32LE(commandOffset + 4);
		assert.ok(size >= 8, "invalid Mach-O load command");
		if (command === 0x32) {
			artifact.platforms.add(bytes.readUInt32LE(commandOffset + 8));
			artifact.minimumVersions.add(
				encodedVersion(bytes.readUInt32LE(commandOffset + 12)),
			);
		} else if (command === 0x2) {
			symbolTable = {
				count: bytes.readUInt32LE(commandOffset + 12),
				offset: bytes.readUInt32LE(commandOffset + 8),
				stringsOffset: bytes.readUInt32LE(commandOffset + 16),
				stringsSize: bytes.readUInt32LE(commandOffset + 20),
			};
		}
		commandOffset += size;
	}
	assert.ok(symbolTable, "Mach-O object is missing LC_SYMTAB");
	const stringsEnd = symbolTable.stringsOffset + symbolTable.stringsSize;
	for (let index = 0; index < symbolTable.count; index += 1) {
		const entry = symbolTable.offset + index * 16;
		const stringIndex = bytes.readUInt32LE(entry);
		const type = bytes[entry + 4];
		const isExternalDefinition =
			(type & 0xe0) === 0 && (type & 0x01) !== 0 && (type & 0x0e) !== 0;
		if (!isExternalDefinition || stringIndex === 0) continue;
		const start = symbolTable.stringsOffset + stringIndex;
		assert.ok(start < stringsEnd, "Mach-O symbol has invalid string offset");
		let end = start;
		while (end < stringsEnd && bytes[end] !== 0) end += 1;
		artifact.symbols.add(bytes.toString("utf8", start, end));
	}
}

function readArchive(bytes, artifact) {
	assert.equal(bytes.toString("ascii", 0, 8), "!<arch>\n");
	let offset = 8;
	while (offset + 60 <= bytes.length) {
		const header = bytes.toString("ascii", offset, offset + 60);
		assert.equal(header.slice(58), "`\n", "invalid ar member header");
		const memberSize = Number.parseInt(header.slice(48, 58).trim(), 10);
		assert.ok(Number.isSafeInteger(memberSize), "invalid ar member size");
		const dataStart = offset + 60;
		const dataEnd = dataStart + memberSize;
		assert.ok(dataEnd <= bytes.length, "ar member extends past archive");
		let objectStart = dataStart;
		const extendedName = header
			.slice(0, 16)
			.trim()
			.match(/^#1\/(\d+)$/);
		if (extendedName) objectStart += Number.parseInt(extendedName[1], 10);
		if (
			objectStart + 4 <= dataEnd &&
			bytes.readUInt32LE(objectStart) === 0xfeedfacf
		) {
			readMachObject(bytes.subarray(objectStart, dataEnd), artifact);
		}
		offset = dataEnd + (memberSize % 2);
	}
}

function inspectAppleStaticLibrary(bytes) {
	const artifact = {
		architectures: new Set(),
		minimumVersions: new Set(),
		platforms: new Set(),
		symbols: new Set(),
	};
	if (bytes.readUInt32BE(0) === 0xcafebabe) {
		const architectures = bytes.readUInt32BE(4);
		for (let index = 0; index < architectures; index += 1) {
			const entry = 8 + index * 20;
			const offset = bytes.readUInt32BE(entry + 8);
			const size = bytes.readUInt32BE(entry + 12);
			readArchive(bytes.subarray(offset, offset + size), artifact);
		}
	} else {
		readArchive(bytes, artifact);
	}
	return artifact;
}

function sha256(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function directorySha256(root) {
	const hash = createHash("sha256");
	const visit = (directory) => {
		for (const name of readdirSync(directory).sort()) {
			const absolute = path.join(directory, name);
			const relative = path.relative(root, absolute);
			if (statSync(absolute).isDirectory()) visit(absolute);
			else {
				hash.update(relative);
				hash.update("\0");
				hash.update(readFileSync(absolute));
				hash.update("\0");
			}
		}
	};
	visit(root);
	return hash.digest("hex");
}

test("vendored Ghostty iOS slices match pinned provenance and export lib-vt", () => {
	assert.equal(provenanceText, `${JSON.stringify(provenance, null, "\t")}\n`);
	assert.equal(provenance.ghostty.revision, revision);
	assert.equal(
		provenance.ghostty.repository,
		"https://github.com/ghostty-org/ghostty.git",
	);
	assert.equal(provenance.zig.version, "0.15.2");
	assert.equal(
		sha256(path.join(vendorRoot, "GhosttyVt.LICENSE")),
		provenance.ghostty.licenseSha256,
	);
	assert.match(provenance.zig.archiveSha256, /^[a-f0-9]{64}$/);
	assert.equal(provenance.build.minimumIOS, "16.4");
	assert.equal(provenance.build.optimize, "ReleaseFast");
	assert.equal(provenance.build.simd, false);
	assert.equal(provenance.build.strip, true);
	assert.equal(provenance.build.seed, 0);
	if (provenance.build.host === "linux-cross-bootstrap") {
		assert.deepEqual(provenance.build.deterministicPaths, {
			globalCache: `/tmp/zuse-ghostty-zig-global-${revision.slice(0, 8)}`,
			output: `/tmp/zuse-ghostty-ios-build-${revision.slice(0, 8)}`,
			source: `/tmp/zuse-ghostty-${revision.slice(0, 8)}`,
			zig: "/tmp/zig-0.15.2",
		});
	}
	assert.deepEqual(provenance.build.targets[1].architectures, [
		"arm64",
		"x86_64",
	]);

	const info = readFileSync(path.join(framework, "Info.plist"), "utf8");
	for (const slice of slices) {
		assert.match(info, new RegExp(`<string>${slice}</string>`));
		const library = path.join(framework, slice, "libghostty-vt.a");
		const bytes = readFileSync(library);
		for (const hostPath of ["/home/", "/Users/", ".cache/zig"]) {
			assert.equal(
				bytes.includes(Buffer.from(hostPath)),
				false,
				`${slice} embeds host-specific path ${hostPath}`,
			);
		}
		const artifact = inspectAppleStaticLibrary(bytes);
		const target = provenance.build.targets.find(
			(entry) => entry.name === slice,
		);
		assert.ok(target, `missing provenance for ${slice}`);
		assert.equal(sha256(library), target.sha256);
		assert.deepEqual(
			[...artifact.architectures].sort(),
			[...target.architectures].sort(),
		);
		assert.deepEqual([...artifact.minimumVersions], ["16.4"]);
		assert.deepEqual(
			[...artifact.platforms],
			[slice === "ios-arm64" ? 2 : 7],
			`${slice} has the wrong Mach-O platform`,
		);
		for (const symbol of requiredSymbols) {
			assert.ok(artifact.symbols.has(symbol), `${slice} is missing ${symbol}`);
		}
		assert.equal(
			artifact.symbols.has("_ghostty_app_new"),
			false,
			`${slice} accidentally contains the full Ghostty app ABI`,
		);
	}
});

test("device and simulator expose the exact same pinned C headers", () => {
	const hashes = slices.map((slice) =>
		directorySha256(path.join(framework, slice, "Headers")),
	);
	assert.equal(hashes[0], hashes[1]);
	assert.equal(hashes[0], provenance.build.headersSha256);
	const moduleMap = readFileSync(
		path.join(framework, slices[0], "Headers/module.modulemap"),
		"utf8",
	);
	assert.match(moduleMap, /module GhosttyVt/);
	assert.match(moduleMap, /umbrella header "ghostty\/vt\.h"/);
});

test("the iOS C adapter is warning-clean against the vendored ABI", () => {
	const compiler = process.env.CC ?? "cc";
	execFileSync(
		compiler,
		[
			"-std=c11",
			"-DGHOSTTY_STATIC",
			"-Wall",
			"-Wextra",
			"-Werror",
			"-fsyntax-only",
			`-I${path.join(framework, slices[0], "Headers")}`,
			path.join(iosModule, "ZuseGhosttySupport.c"),
			path.join(iosModule, "Tests/ZuseGhosttyHostTests.c"),
		],
		{ stdio: "pipe" },
	);
});

test("every C adapter function called from Swift is publicly declared", () => {
	const header = readFileSync(
		path.join(iosModule, "ZuseGhosttySupport.h"),
		"utf8",
	);
	const emulator = readFileSync(
		path.join(iosModule, "ZuseGhosttyEmulator.swift"),
		"utf8",
	);
	const adapterCalls = new Set(
		emulator.match(/\bzuse_ghostty_[a-z0-9_]+(?=\s*\()/g) ?? [],
	);
	assert.ok(adapterCalls.size > 0, "expected Swift to call the C adapter");
	for (const name of adapterCalls) {
		assert.match(
			header,
			new RegExp(`\\b${name}\\s*\\(`),
			`Swift calls undeclared C adapter function ${name}`,
		);
	}
	assert.doesNotMatch(
		emulator,
		/\bghostty_selection_controller_reset\s*\(/,
		"selection lifecycle must call the declared zuse_ghostty adapter",
	);
});

test("iOS has one Ghostty path and retains the complete terminal interaction contract", () => {
	const podspec = readFileSync(
		path.join(iosModule, "ZuseMobileTerminal.podspec"),
		"utf8",
	);
	const emulator = readFileSync(
		path.join(iosModule, "ZuseGhosttyEmulator.swift"),
		"utf8",
	);
	const view = readFileSync(
		path.join(iosModule, "ZuseMobileTerminalModule.swift"),
		"utf8",
	);
	const support = readFileSync(
		path.join(iosModule, "ZuseGhosttySupport.c"),
		"utf8",
	);
	const viewShim = readFileSync(
		path.join(
			repository,
			"apps/mobile/modules/mobile-terminal/src/ZuseMobileTerminalView.tsx",
		),
		"utf8",
	);
	const podfileLock = readFileSync(
		path.join(repository, "apps/mobile/ios/Podfile.lock"),
		"utf8",
	);
	const packageResolved = readFileSync(
		path.join(
			repository,
			"apps/mobile/ios/ZuseMobile.xcworkspace/xcshareddata/swiftpm/Package.resolved",
		),
		"utf8",
	);
	const combined = `${podspec}\n${emulator}\n${view}\n${support}`;
	assert.doesNotMatch(
		combined,
		/import SwiftTerm|spm_dependency[\s\S]*SwiftTerm/,
	);
	assert.doesNotMatch(packageResolved, /swiftterm/i);
	assert.doesNotThrow(() => JSON.parse(packageResolved));
	assert.match(
		viewShim,
		/requireNativeViewManager\(\s*"ZuseMobileTerminal"\s*\)/,
		"Apple must resolve the module's registered default native view",
	);
	assert.doesNotMatch(
		viewShim,
		/requireNativeViewManager\(\s*"ZuseMobileTerminal"\s*,/,
		"Apple must not request an unregistered named view",
	);
	assert.match(podspec, /GhosttyVt\.xcframework/);
	assert.match(
		podspec,
		/ghostty_license = File\.expand_path\('\.\.\/Vendor\/GhosttyVt\.LICENSE', __dir__\)/,
	);
	assert.match(
		podspec,
		/zuse_license = File\.expand_path\('\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/LICENSE', __dir__\)/,
	);
	assert.match(
		podspec,
		/s\.license\s*=\s*\{ :type => 'AGPL-3\.0-only', :text => File\.read\(zuse_license\) \}/,
	);
	assert.doesNotMatch(podspec, /s\.license[\s\S]*?:type => 'MIT'/);
	assert.match(
		podspec,
		/s\.preserve_paths\s*=\s*'\.\.\/Vendor\/GhosttyVt\.LICENSE'/,
	);
	assert.match(
		podspec,
		/s\.resource_bundles\s*=\s*\{\s*'ZuseMobileTerminalLicenses'\s*=>\s*\['\.\.\/Vendor\/GhosttyVt\.LICENSE'\]\s*\}/,
	);
	assert.match(podspec, /\*\.\{c,h,m,mm,swift\}/);
	const podspecChecksum = createHash("sha1").update(podspec).digest("hex");
	assert.match(
		podfileLock,
		new RegExp(`ZuseMobileTerminal: ${podspecChecksum}`),
	);
	for (const behavior of [
		"zuse_ghostty_output_queue_install",
		"zuse_ghostty_output_queue_set_size",
		"ghostty_key_encoder_setopt_from_terminal",
		"zuse_ghostty_encode_paste",
		"zuse_ghostty_mouse_encode",
		"ghostty_mouse_encoder_setopt_from_terminal",
		"UIHoverGestureRecognizer",
		"allowedScrollTypesMask",
		"modifierFlags\\.contains\\(\\.shift\\)",
		"zuse_ghostty_scroll_rows",
		"zuse_ghostty_selection_drag",
		"zuse_ghostty_selection_autoscroll_tick",
		"zuse_ghostty_viewport_hyperlink",
		"GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY",
		"GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_WIDE_TAIL",
		"GHOSTTY_CELL_DATA_WIDE",
		"accessibilityScroll",
		"UIApplication.willResignActiveNotification",
		"ghostty_terminal_reset",
	]) {
		assert.match(combined, new RegExp(behavior));
	}
	assert.doesNotMatch(
		view,
		/GHOSTTY_KEY_ACTION_REPEAT/,
		"UIKit analog-value changes must never be mislabeled as key repeats",
	);
	const changedHandler = view.match(
		/public override func pressesChanged[\s\S]*?(?=\n {2}public override func pressesCancelled)/,
	)?.[0];
	assert.ok(changedHandler, "expected the UIKit pressesChanged override");
	assert.match(changedHandler, /phase:\s*\.changed/);
	assert.match(
		changedHandler,
		/super\.pressesChanged\(unhandled, with: event\)/,
	);
});

test("iOS resets its native feed sequence when React clears the feed prop", () => {
	const view = readFileSync(
		path.join(iosModule, "ZuseMobileTerminalModule.swift"),
		"utf8",
	);
	assert.match(
		view,
		/guard let value else \{\s*latestFeedSequence = -1\s*return\s*\}/,
	);
});

test("iOS discards pointer and selection state at a RIS terminal epoch", () => {
	const header = readFileSync(
		path.join(iosModule, "ZuseGhosttySupport.h"),
		"utf8",
	);
	const support = readFileSync(
		path.join(iosModule, "ZuseGhosttySupport.c"),
		"utf8",
	);
	const emulator = readFileSync(
		path.join(iosModule, "ZuseGhosttyEmulator.swift"),
		"utf8",
	);
	const view = readFileSync(
		path.join(iosModule, "ZuseMobileTerminalModule.swift"),
		"utf8",
	);
	assert.match(
		header,
		/bool zuse_ghostty_focus_controller_observe_vt_input\s*\(/,
	);
	assert.match(
		support,
		/!controller->button_pressed[\s\S]*?action == GHOSTTY_MOUSE_ACTION_MOTION[\s\S]*?action == GHOSTTY_MOUSE_ACTION_RELEASE/,
	);
	assert.match(
		emulator,
		/resetEpoch = zuse_ghostty_focus_controller_observe_vt_input[\s\S]*?zuse_ghostty_selection_controller_reset[\s\S]*?zuse_ghostty_mouse_controller_reset/,
	);
	assert.match(
		view,
		/if result\.resetEpoch \{[\s\S]*?resetTransientInputState\(sendPointerRelease: false\)/,
	);
});

test("the cross-platform rebuild script pins supply chain and refuses dirty source", () => {
	const build = readFileSync(
		path.join(repository, "scripts/build-ghostty-ios.mjs"),
		"utf8",
	);
	const bootstrap = readFileSync(
		path.join(repository, "scripts/lib/ghostty-build-bootstrap.mjs"),
		"utf8",
	);
	const supplyChain = `${build}\n${bootstrap}`;
	assert.match(
		supplyChain,
		/3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b/,
	);
	assert.match(
		supplyChain,
		/375b6909fc1495d16fc2c7db9538f707456bfc3373b14ee83fdd3e22b3d43f7f/,
	);
	assert.match(supplyChain, /"status",\s*"--porcelain"/);
	assert.match(supplyChain, /"rev-parse",\s*"FETCH_HEAD"/);
	assert.match(supplyChain, /Cached Ghostty source has local changes/);
	assert.match(build, /-Dtarget=\$\{target\.target\}/);
	assert.match(build, /"--seed",\s*"0"/);
	assert.match(build, /"--global-cache-dir"/);
	assert.match(build, /xcodebuild/);
	assert.match(build, /linux-cross-bootstrap/);
	assert.match(build, /process\.platform === "linux"/);
	assert.match(build, /zuse-ghostty-\$\{revision\.slice\(0, 8\)\}/);
	assert.match(build, /zuse-ghostty-ios-build-\$\{revision\.slice\(0, 8\)\}/);
	assert.doesNotMatch(
		build,
		/if \(process\.platform !== "darwin"\) \{\s*throw new Error/,
	);
	assert.match(build, /_ghostty_terminal_new/);
});

test("the checked-in Xcode project and scheme own a runnable XCTest target", () => {
	const project = readFileSync(
		path.join(
			repository,
			"apps/mobile/ios/ZuseMobile.xcodeproj/project.pbxproj",
		),
		"utf8",
	);
	const scheme = readFileSync(
		path.join(
			repository,
			"apps/mobile/ios/ZuseMobile.xcodeproj/xcshareddata/xcschemes/ZuseMobile.xcscheme",
		),
		"utf8",
	);
	const podfile = readFileSync(
		path.join(repository, "apps/mobile/ios/Podfile"),
		"utf8",
	);
	const nativeCheck = readFileSync(
		path.join(repository, "scripts/check-ghostty-ios-native.mjs"),
		"utf8",
	);
	const testTarget = "00E356ED1AD99517003FC87E";

	assert.match(
		project,
		new RegExp(
			`${testTarget} /\\* ZuseMobileTests \\*/ = \\{[\\s\\S]*?productType = "com\\.apple\\.product-type\\.bundle\\.unit-test";`,
		),
	);
	assert.match(project, /\.\.\/modules\/mobile-terminal\/ios\/Tests/);
	assert.match(project, /ZuseMobileTerminalTests\.swift in Sources/);
	assert.match(
		project,
		/PBXTargetDependency[\s\S]*?target = 13B07F861A680F5B00A75B9A \/\* ZuseMobile \*\//,
	);
	const blueprintIdentifiers = [
		...scheme.matchAll(/BlueprintIdentifier = "([A-F0-9]+)"/g),
	].map((match) => match[1]);
	assert.equal(
		blueprintIdentifiers.filter((identifier) => identifier === testTarget)
			.length,
		2,
		"the XCTest target must participate in both BuildAction and TestAction",
	);
	for (const identifier of blueprintIdentifiers) {
		assert.match(
			project,
			new RegExp(`${identifier} /\\* (?:ZuseMobile|ZuseMobileTests) \\*/ =`),
			`scheme references missing project target ${identifier}`,
		);
	}
	assert.match(
		podfile,
		/target 'ZuseMobileTests' do\s+inherit! :complete\s+end/,
	);
	assert.match(nativeCheck, /simctl", "list", "devices", "available"/);
	assert.match(nativeCheck, /"-only-testing:ZuseMobileTests"/);
	assert.match(nativeCheck, /"test"/);
});
