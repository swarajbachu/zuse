import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGhosttyBuildBootstrap } from "./lib/ghostty-build-bootstrap.mjs";

const linuxHost = process.platform === "linux";
const macHost = process.platform === "darwin";
const deterministicRoot = realpathSync("/tmp");
if (!linuxHost && !macHost) {
	throw new Error(
		`Ghostty iOS builds require Linux cross-compilation or macOS/Xcode; found ${process.platform}`,
	);
}

const repository = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const revision = readFileSync(
	path.join(repository, "native/libghostty-vt/VERSION"),
	"utf8",
).trim();
const zigVersion = "0.15.2";
const minimumIOS = "16.4";
const cache = path.join(homedir(), ".cache", "zuse", "ghostty");
// Linux shares the verified toolchain cache with the WebAssembly builder. The
// macOS cache remains architecture-qualified because one checkout may build a
// universal application with both host toolchains over time.
const bootstrap = createGhosttyBuildBootstrap({
	cacheRoot: cache,
	revision,
	zigVersion,
	tempLabel: "ios",
	zigRootName: macHost
		? `zig-${zigVersion}-${process.arch}`
		: `zig-${zigVersion}`,
});
const source = bootstrap.sourceRoot;
const zig = bootstrap.zigExecutable;
const zigArchive = bootstrap.zigArchive;
const distributionName = bootstrap.zigDistribution;
const distributionSha256 = bootstrap.zigArchiveSha256;
const vendorRoot = path.join(
	repository,
	"apps/mobile/modules/mobile-terminal/Vendor",
);
const destination = path.join(vendorRoot, "GhosttyVt.xcframework");
const provenanceDestination = path.join(
	vendorRoot,
	"GhosttyVt.provenance.json",
);
const licenseDestination = path.join(vendorRoot, "GhosttyVt.LICENSE");
const requiredSymbols = [
	"_ghostty_terminal_new",
	"_ghostty_terminal_vt_write",
	"_ghostty_render_state_new",
	"_ghostty_key_encoder_encode",
	"_ghostty_paste_encode",
	"_ghostty_selection_gesture_event",
	"_ghostty_grid_ref_hyperlink_uri",
];
const targets = [
	{
		name: "ios-arm64",
		target: `aarch64-ios.${minimumIOS}`,
		architecture: "arm64",
	},
	{
		name: "ios-simulator-arm64",
		target: `aarch64-ios.${minimumIOS}-simulator`,
		architecture: "arm64",
	},
	{
		name: "ios-simulator-x86_64",
		target: `x86_64-ios.${minimumIOS}-simulator`,
		architecture: "x86_64",
	},
];

function run(command, arguments_, options = {}) {
	return execFileSync(command, arguments_, { stdio: "inherit", ...options });
}

function output(command, arguments_, options = {}) {
	return execFileSync(command, arguments_, {
		encoding: "utf8",
		...options,
	}).trim();
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
			const stats = statSync(absolute);
			if (stats.isDirectory()) visit(absolute);
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

function assertCleanCheckout() {
	const status = output("git", ["-C", source, "status", "--porcelain"]);
	if (status !== "") {
		throw new Error(
			`Refusing to build from dirty Ghostty cache ${source}. Remove it or clean it explicitly.`,
		);
	}
}

/**
 * Zig's upstream Ghostty build installs both shared and static lib-vt targets.
 * We package only the static archive; the unrelated shared target can fail
 * SDK linking even when that archive is valid. Stage the pinned source and
 * remove only the shared install dependency. Linux keeps a stable source path
 * to make clean cross-builds byte-exact.
 */
function makeStaticSource(directory) {
	const stagedSource = directory;
	if (existsSync(stagedSource)) {
		throw new Error(
			`Deterministic Ghostty staging path is already in use: ${stagedSource}`,
		);
	}
	const archive = path.join(
		deterministicRoot,
		`zuse-ghostty-source-${revision.slice(0, 8)}-${process.pid}.tar`,
	);
	mkdirSync(stagedSource, { recursive: false });
	let complete = false;
	try {
		run("git", [
			"-C",
			source,
			"archive",
			"--format=tar",
			`--output=${archive}`,
			revision,
		]);
		run("tar", ["-xf", archive, "-C", stagedSource]);
		const buildFile = path.join(stagedSource, "build.zig");
		const upstream = readFileSync(buildFile, "utf8");
		const sharedInstall =
			"    libghostty_vt_shared.install(b.getInstallStep());";
		if (upstream.split(sharedInstall).length !== 2) {
			throw new Error(
				"Pinned Ghostty build graph no longer has the expected shared install edge",
			);
		}
		writeFileSync(
			buildFile,
			upstream.replace(
				sharedInstall,
				[
					"    // Zuse Linux cross-bootstrap installs only the static lib-vt target.",
					"    _ = libghostty_vt_shared;",
				].join("\n"),
			),
		);
		complete = true;
		return stagedSource;
	} finally {
		rmSync(archive, { force: true });
		if (!complete) {
			rmSync(stagedSource, { recursive: true, force: true });
		}
	}
}

/**
 * Zig records its standard-library source paths in Mach-O objects even for a
 * stripped release archive. Re-extract the checksum-verified distribution at
 * the same absolute path for every build so artifact bytes do not depend
 * on the current user's home directory. The path itself is also a build lock.
 */
function makeCanonicalZig() {
	const stagedZigRoot = path.join(deterministicRoot, `zig-${zigVersion}`);
	if (existsSync(stagedZigRoot)) {
		throw new Error(
			`Deterministic Zig staging path is already in use: ${stagedZigRoot}`,
		);
	}
	const extraction = mkdtempSync(
		path.join(tmpdir(), "zuse-zig-ios-toolchain-"),
	);
	try {
		run("tar", ["-xJf", zigArchive, "--strip-components=1", "-C", extraction]);
		const extractedZig = path.join(extraction, "zig");
		if (sha256(extractedZig) !== sha256(zig)) {
			throw new Error("Canonical Zig extraction does not match verified cache");
		}
		renameSync(extraction, stagedZigRoot);
	} finally {
		if (existsSync(extraction)) {
			rmSync(extraction, { recursive: true, force: true });
		}
	}
	return path.join(stagedZigRoot, "zig");
}

function validateLibrary(library) {
	const symbols = linuxHost
		? output("llvm-nm", ["-gU", library])
		: output("xcrun", ["nm", "-gU", library]);
	for (const symbol of requiredSymbols) {
		if (!symbols.includes(symbol)) {
			throw new Error(`${library} is missing required symbol ${symbol}`);
		}
	}
	if (symbols.includes("_ghostty_app_new")) {
		throw new Error(`${library} contains the full Ghostty app ABI`);
	}
}

function alignArchiveMembers(library) {
	// Zig's ar writer can leave compiler_rt.o only 4-byte aligned. Apple's
	// linker requires 8-byte alignment. Extract first: libtool may silently
	// omit an unaligned member when passed the original archive directly.
	const directory = path.join(path.dirname(library), "archive-objects");
	mkdirSync(directory);
	if (macHost) run("xcrun", ["ar", "x", library], { cwd: directory });
	else run("llvm-ar", ["x", library], { cwd: directory });
	const objects = readdirSync(directory)
		.filter((name) => !/^__\.SYMDEF(?: SORTED)?$/.test(name))
		.sort()
		.map((name) => path.join(directory, name));
	if (objects.length === 0 || objects.some((file) => !file.endsWith(".o"))) {
		throw new Error("Unexpected Ghostty static archive members");
	}
	// Apple's ar preserves Zig's zero permission bits on extracted objects.
	for (const object of objects) chmodSync(object, 0o644);
	const aligned = `${library}.aligned`;
	const arguments_ = ["-static", "-D", ...objects, "-o", aligned];
	if (macHost) run("xcrun", ["libtool", ...arguments_]);
	else run("llvm-libtool-darwin", arguments_);
	renameSync(aligned, library);
}

const alignTo = (value, alignment) => Math.ceil(value / alignment) * alignment;

/** Create the deterministic two-slice FAT_MAGIC archive emitted by lipo. */
function writeUniversalSimulatorLibrary(armLibrary, x86Library, destination_) {
	const arm = readFileSync(armLibrary);
	const x86 = readFileSync(x86Library);
	const headerSize = 48;
	const alignmentPower = 3;
	const alignment = 2 ** alignmentPower;
	const x86Offset = headerSize;
	const armOffset = alignTo(x86Offset + x86.byteLength, alignment);
	const bytes = Buffer.alloc(armOffset + arm.byteLength);
	bytes.writeUInt32BE(0xcafebabe, 0);
	bytes.writeUInt32BE(2, 4);
	// x86_64 (CPU_TYPE_X86_64, CPU_SUBTYPE_X86_64_ALL)
	bytes.writeUInt32BE(0x01000007, 8);
	bytes.writeUInt32BE(3, 12);
	bytes.writeUInt32BE(x86Offset, 16);
	bytes.writeUInt32BE(x86.byteLength, 20);
	bytes.writeUInt32BE(alignmentPower, 24);
	// arm64 (CPU_TYPE_ARM64, CPU_SUBTYPE_ARM64_ALL)
	bytes.writeUInt32BE(0x0100000c, 28);
	bytes.writeUInt32BE(0, 32);
	bytes.writeUInt32BE(armOffset, 36);
	bytes.writeUInt32BE(arm.byteLength, 40);
	bytes.writeUInt32BE(alignmentPower, 44);
	x86.copy(bytes, x86Offset);
	arm.copy(bytes, armOffset);
	writeFileSync(destination_, bytes);
}

const xcframeworkInfo = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AvailableLibraries</key>
	<array>
		<dict>
			<key>LibraryIdentifier</key>
			<string>ios-arm64</string>
			<key>LibraryPath</key>
			<string>libghostty-vt.a</string>
			<key>HeadersPath</key>
			<string>Headers</string>
			<key>SupportedArchitectures</key>
			<array><string>arm64</string></array>
			<key>SupportedPlatform</key>
			<string>ios</string>
		</dict>
		<dict>
			<key>LibraryIdentifier</key>
			<string>ios-arm64_x86_64-simulator</string>
			<key>LibraryPath</key>
			<string>libghostty-vt.a</string>
			<key>HeadersPath</key>
			<string>Headers</string>
			<key>SupportedArchitectures</key>
			<array>
				<string>arm64</string>
				<string>x86_64</string>
			</array>
			<key>SupportedPlatform</key>
			<string>ios</string>
			<key>SupportedPlatformVariant</key>
			<string>simulator</string>
		</dict>
	</array>
	<key>CFBundlePackageType</key>
	<string>XFWK</string>
	<key>XCFrameworkFormatVersion</key>
	<string>1.0</string>
</dict>
</plist>
`;

function makeLinuxXcframework(generated, headers, device, simulator) {
	const deviceRoot = path.join(generated, "ios-arm64");
	const simulatorRoot = path.join(generated, "ios-arm64_x86_64-simulator");
	mkdirSync(deviceRoot, { recursive: true });
	mkdirSync(simulatorRoot, { recursive: true });
	cpSync(headers, path.join(deviceRoot, "Headers"), { recursive: true });
	cpSync(headers, path.join(simulatorRoot, "Headers"), { recursive: true });
	cpSync(device, path.join(deviceRoot, "libghostty-vt.a"));
	cpSync(simulator, path.join(simulatorRoot, "libghostty-vt.a"));
	writeFileSync(path.join(generated, "Info.plist"), xcframeworkInfo);
}

function replaceDirectoryAtomically(sourceDirectory, targetDirectory) {
	const staged = `${targetDirectory}.next-${process.pid}`;
	const backup = `${targetDirectory}.previous-${process.pid}`;
	rmSync(staged, { recursive: true, force: true });
	rmSync(backup, { recursive: true, force: true });
	cpSync(sourceDirectory, staged, { recursive: true });
	if (existsSync(targetDirectory)) renameSync(targetDirectory, backup);
	try {
		renameSync(staged, targetDirectory);
		rmSync(backup, { recursive: true, force: true });
	} catch (cause) {
		if (!existsSync(targetDirectory) && existsSync(backup)) {
			renameSync(backup, targetDirectory);
		}
		throw cause;
	} finally {
		rmSync(staged, { recursive: true, force: true });
	}
}

function macosBuildEnvironment(directory) {
	if (!macHost || process.arch !== "arm64") return process.env;
	const sdk = output("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
	const targets = readFileSync(
		path.join(sdk, "usr/lib/libSystem.tbd"),
		"utf8",
	).match(/targets:\s*\[([^\]]+)\]/)?.[1];
	if (targets?.includes("arm64-macos")) return process.env;
	// Zig 0.15.2 cannot resolve host symbols from arm64e-only macOS SDK stubs.
	// Route only its macOS SDK lookup to CLT; iOS and packaging still use Xcode.
	const bin = path.join(directory, "host-sdk-bin");
	mkdirSync(bin);
	const wrapper = path.join(bin, "xcrun");
	cpSync(new URL("./lib/ghostty-host-xcrun.sh", import.meta.url), wrapper);
	chmodSync(wrapper, 0o755);
	return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
}

let buildRoot;
let buildSource = source;
let buildZig = zig;
let buildGlobalCache;
let releaseBootstrap;
try {
	{
		const globalCache = path.join(
			deterministicRoot,
			`zuse-ghostty-zig-global-${revision.slice(0, 8)}`,
		);
		if (existsSync(globalCache)) {
			throw new Error(
				`Deterministic Ghostty build path is already in use: ${globalCache}`,
			);
		}
		mkdirSync(globalCache, { recursive: false });
		buildGlobalCache = globalCache;
	}

	releaseBootstrap = bootstrap.prepare();

	const outputRoot = path.join(
		deterministicRoot,
		`zuse-ghostty-ios-build-${revision.slice(0, 8)}`,
	);
	if (existsSync(outputRoot)) {
		throw new Error(
			`Deterministic Ghostty build path is already in use: ${outputRoot}`,
		);
	}
	mkdirSync(outputRoot, { recursive: false });
	buildRoot = outputRoot;

	buildSource = makeStaticSource(
		path.join(deterministicRoot, `zuse-ghostty-${revision.slice(0, 8)}`),
	);
	buildZig = makeCanonicalZig();
	const buildEnvironment = macosBuildEnvironment(buildRoot);
	const headers = path.join(buildRoot, "Headers");
	mkdirSync(path.join(headers, "ghostty"), { recursive: true });
	cpSync(
		path.join(buildSource, "include/ghostty/vt.h"),
		path.join(headers, "ghostty/vt.h"),
	);
	cpSync(
		path.join(buildSource, "include/ghostty/vt"),
		path.join(headers, "ghostty/vt"),
		{ recursive: true },
	);
	writeFileSync(
		path.join(headers, "module.modulemap"),
		'module GhosttyVt {\n    umbrella header "ghostty/vt.h"\n    export *\n}\n',
	);

	for (const target of targets) {
		const prefix = path.join(buildRoot, target.name);
		run(
			buildZig,
			[
				"build",
				"--seed",
				"0",
				...(buildGlobalCache === undefined
					? []
					: ["--global-cache-dir", buildGlobalCache]),
				"-Demit-lib-vt=true",
				"-Demit-xcframework=false",
				`-Dtarget=${target.target}`,
				"-Dsimd=false",
				"-Doptimize=ReleaseFast",
				"-Dstrip=true",
				`-Dlib-version-string=0.1.0-dev+${revision}`,
				"-p",
				prefix,
			],
			{ cwd: buildSource, env: buildEnvironment },
		);
		target.library = path.join(prefix, "lib/libghostty-vt.a");
		if (!existsSync(target.library)) {
			throw new Error(`Ghostty did not produce ${target.library}`);
		}
		alignArchiveMembers(target.library);
		validateLibrary(target.library);
	}
	const simulatorLibrary = path.join(buildRoot, "simulator", "libghostty-vt.a");
	mkdirSync(path.dirname(simulatorLibrary));
	if (linuxHost) {
		writeUniversalSimulatorLibrary(
			targets[1].library,
			targets[2].library,
			simulatorLibrary,
		);
	} else {
		run("xcrun", [
			"lipo",
			"-create",
			targets[1].library,
			targets[2].library,
			"-output",
			simulatorLibrary,
		]);
	}

	const adapter = path.join(
		repository,
		"apps/mobile/modules/mobile-terminal/ios/ZuseGhosttySupport.c",
	);
	if (macHost) {
		run("xcrun", [
			"--sdk",
			"iphonesimulator",
			"clang",
			"-arch",
			"arm64",
			`-mios-simulator-version-min=${minimumIOS}`,
			"-std=c11",
			"-DGHOSTTY_STATIC",
			"-Wall",
			"-Wextra",
			"-Werror",
			"-fsyntax-only",
			`-I${headers}`,
			adapter,
		]);
	} else {
		run(process.env.CC ?? "cc", [
			"-std=c11",
			"-DGHOSTTY_STATIC",
			"-Wall",
			"-Wextra",
			"-Werror",
			"-fsyntax-only",
			`-I${headers}`,
			adapter,
		]);
	}

	const generated = path.join(buildRoot, "GhosttyVt.xcframework");
	if (macHost) {
		run("xcodebuild", [
			"-create-xcframework",
			"-library",
			targets[0].library,
			"-headers",
			headers,
			"-library",
			simulatorLibrary,
			"-headers",
			headers,
			"-output",
			generated,
		]);
	} else {
		makeLinuxXcframework(
			generated,
			headers,
			targets[0].library,
			simulatorLibrary,
		);
	}
	if (!existsSync(path.join(generated, "Info.plist"))) {
		throw new Error(`iOS packaging did not produce ${generated}`);
	}

	const provenance = {
		ghostty: {
			repository: "https://github.com/ghostty-org/ghostty.git",
			revision,
			licenseSha256: sha256(path.join(source, "LICENSE")),
		},
		zig: {
			version: zigVersion,
			distribution: distributionName,
			archiveSha256: distributionSha256,
			binarySha256: sha256(buildZig),
		},
		build: {
			host: linuxHost ? "linux-cross-bootstrap" : "macos-xcode",
			seed: 0,
			...(linuxHost
				? {
						deterministicPaths: {
							globalCache: buildGlobalCache,
							output: buildRoot,
							source: buildSource,
							zig: path.dirname(buildZig),
						},
					}
				: {}),
			minimumIOS,
			optimize: "ReleaseFast",
			simd: false,
			strip: true,
			targets: [
				{
					name: "ios-arm64",
					target: targets[0].target,
					architectures: [targets[0].architecture],
					sha256: sha256(targets[0].library),
				},
				{
					name: "ios-arm64_x86_64-simulator",
					targets: targets.slice(1).map(({ target, library }) => ({
						target,
						sha256: sha256(library),
					})),
					architectures: targets
						.slice(1)
						.map(({ architecture }) => architecture),
					sha256: sha256(simulatorLibrary),
				},
			],
			headersSha256: directorySha256(headers),
		},
	};
	mkdirSync(vendorRoot, { recursive: true });
	replaceDirectoryAtomically(generated, destination);
	const provenancePartial = `${provenanceDestination}.partial-${process.pid}`;
	writeFileSync(
		provenancePartial,
		`${JSON.stringify(provenance, null, "\t")}\n`,
	);
	renameSync(provenancePartial, provenanceDestination);
	const licensePartial = `${licenseDestination}.partial-${process.pid}`;
	cpSync(path.join(source, "LICENSE"), licensePartial);
	renameSync(licensePartial, licenseDestination);
	assertCleanCheckout();
} finally {
	releaseBootstrap?.();
	if (buildRoot !== undefined) {
		rmSync(buildRoot, { recursive: true, force: true });
	}
	if (buildSource !== source) {
		rmSync(buildSource, { recursive: true, force: true });
	}
	if (buildZig !== zig) {
		rmSync(path.dirname(buildZig), { recursive: true, force: true });
	}
	if (buildGlobalCache !== undefined) {
		rmSync(buildGlobalCache, { recursive: true, force: true });
	}
}
console.log(`Wrote ${path.relative(repository, destination)}`);
