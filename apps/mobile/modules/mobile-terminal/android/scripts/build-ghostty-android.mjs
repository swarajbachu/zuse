import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGhosttyBuildBootstrap } from "../../../../../../scripts/lib/ghostty-build-bootstrap.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(moduleRoot, "../../../../../");
const provenanceVersion = "native/libghostty-vt/VERSION";
const provenanceRoot = path.dirname(
	path.join(repositoryRoot, provenanceVersion),
);
const revision = readFileSync(
	path.join(repositoryRoot, provenanceVersion),
	"utf8",
).trim();
const zigVersion = "0.15.2";
const ndkVersion = "27.1.12297006";
const androidApi = 24;
const buildRecipeVersion = 4;
const deterministicRoot = "/tmp";
const cacheRoot = path.join(homedir(), ".cache", "zuse", "ghostty-android");
const externalZig = process.env.ZUSE_GHOSTTY_ZIG;
const vendorRoot = path.join(moduleRoot, "vendor");
const bootstrap = createGhosttyBuildBootstrap({
	cacheRoot,
	revision,
	zigVersion,
	tempLabel: "android",
	externalZig,
});
const sourceRoot = bootstrap.sourceRoot;
const cachedZig = bootstrap.cachedZigExecutable;
const hostPlatform = bootstrap.hostPlatform;
const hostArchitecture = bootstrap.hostArchitecture;

const targetForAbi = new Map([
	["arm64-v8a", `aarch64-linux-android.${androidApi}`],
	["x86_64", `x86_64-linux-android.${androidApi}`],
]);
const zigDistribution = bootstrap.zigDistribution;
const expectedZigArchiveSha256 = bootstrap.zigArchiveSha256;
const zigArchive = bootstrap.zigArchive;
const deterministicPaths = {
	globalCache: path.join(
		deterministicRoot,
		`zuse-ghostty-android-zig-global-${revision.slice(0, 8)}`,
	),
	ndk: path.join(deterministicRoot, `zuse-ghostty-android-ndk-${ndkVersion}`),
	output: path.join(
		deterministicRoot,
		`zuse-ghostty-android-build-${revision.slice(0, 8)}`,
	),
	source: path.join(
		deterministicRoot,
		`zuse-ghostty-android-source-${revision.slice(0, 8)}`,
	),
	zig: path.join(deterministicRoot, `zuse-ghostty-android-zig-${zigVersion}`),
};

const abiArgument = process.argv.find((argument) =>
	argument.startsWith("--abis="),
);
const requestedAbis = (
	abiArgument?.slice("--abis=".length) ?? "arm64-v8a,x86_64"
)
	.split(",")
	.map((value) => value.trim())
	.filter(Boolean);

if (requestedAbis.length === 0) {
	throw new Error("At least one Android ABI is required");
}
for (const abi of requestedAbis) {
	if (!targetForAbi.has(abi)) {
		throw new Error(`Unsupported Android ABI: ${abi}`);
	}
}

const run = (command, args, options = {}) =>
	execFileSync(command, args, { stdio: "inherit", ...options });

const sha256 = (file) =>
	createHash("sha256").update(readFileSync(file)).digest("hex");

const treeSha256 = (directory) => {
	const files = [];
	const visit = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const absolute = path.join(current, entry.name);
			if (entry.isDirectory()) visit(absolute);
			else if (entry.isFile()) {
				files.push([
					path.relative(directory, absolute).split(path.sep).join("/"),
					sha256(absolute),
				]);
			}
		}
	};
	visit(directory);
	files.sort(([left], [right]) => left.localeCompare(right));
	return createHash("sha256").update(JSON.stringify(files)).digest("hex");
};

/**
 * Ghostty's upstream build installs both static and shared lib-vt targets. The
 * shared Android target requires an NDK even though the static archive is
 * self-contained. Stage the exact pinned tree at a fixed path and remove only
 * that shared install edge so this recipe produces the library Gradle links.
 */
function makeDeterministicSource() {
	if (existsSync(deterministicPaths.source)) {
		throw new Error(
			`Deterministic Ghostty build path is already in use: ${deterministicPaths.source}`,
		);
	}
	const archive = path.join(
		deterministicRoot,
		`zuse-ghostty-android-source-${revision.slice(0, 8)}-${process.pid}.tar`,
	);
	mkdirSync(deterministicPaths.source, { recursive: false });
	let complete = false;
	try {
		run("git", [
			"-C",
			sourceRoot,
			"archive",
			"--format=tar",
			`--output=${archive}`,
			revision,
		]);
		run("tar", ["-xf", archive, "-C", deterministicPaths.source]);
		const buildFile = path.join(deterministicPaths.source, "build.zig");
		const upstream = readFileSync(buildFile, "utf8");
		const sharedTarget = `    const libghostty_vt_shared = shared: {
        if (config.target.result.cpu.arch.isWasm()) {
            break :shared try buildpkg.GhosttyLibVt.initWasm(
                b,
                &mod,
            );
        }

        break :shared try buildpkg.GhosttyLibVt.initShared(
            b,
            &mod,
        );
    };
    libghostty_vt_shared.install(b.getInstallStep());`;
		if (upstream.split(sharedTarget).length !== 2) {
			throw new Error(
				"Pinned Ghostty build graph no longer has the expected shared lib-vt target",
			);
		}
		writeFileSync(
			buildFile,
			upstream.replace(
				sharedTarget,
				"    // Zuse Android builds and packages only the static lib-vt target.",
			),
		);
		complete = true;
		return deterministicPaths.source;
	} finally {
		rmSync(archive, { force: true });
		if (!complete) {
			rmSync(deterministicPaths.source, { recursive: true, force: true });
		}
	}
}

/** Extract the verified Zig distribution at one compiler-visible path. */
function makeDeterministicZig() {
	if (existsSync(deterministicPaths.zig)) {
		throw new Error(
			`Deterministic Ghostty build path is already in use: ${deterministicPaths.zig}`,
		);
	}
	const extraction = mkdtempSync(
		path.join(deterministicRoot, "zuse-zig-android-toolchain-"),
	);
	try {
		run("tar", ["-xJf", zigArchive, "--strip-components=1", "-C", extraction]);
		if (sha256(path.join(extraction, "zig")) !== sha256(cachedZig)) {
			throw new Error("Canonical Zig extraction does not match verified cache");
		}
		renameSync(extraction, deterministicPaths.zig);
	} finally {
		if (existsSync(extraction)) {
			rmSync(extraction, { recursive: true, force: true });
		}
	}
	return path.join(deterministicPaths.zig, "zig");
}

const hostSpecificPaths = ["/home/", "/Users/", ".cache/zig"];
const artifactIsPortable = (file) => {
	const bytes = readFileSync(file);
	return hostSpecificPaths.every(
		(hostPath) => !bytes.includes(Buffer.from(hostPath)),
	);
};

function validateNdk(candidate) {
	try {
		const properties = readFileSync(
			path.join(candidate, "source.properties"),
			"utf8",
		);
		if (
			!new RegExp(`^Pkg\\.Revision\\s*=\\s*${ndkVersion}$`, "m").test(
				properties,
			)
		) {
			return null;
		}
		if (!existsSync(path.join(candidate, "toolchains/llvm/prebuilt"))) {
			return null;
		}
		return realpathSync(candidate);
	} catch {
		return null;
	}
}

function findNdk() {
	if (process.env.ANDROID_NDK_HOME !== undefined) {
		const configured = validateNdk(process.env.ANDROID_NDK_HOME);
		if (configured === null) {
			throw new Error(
				`ANDROID_NDK_HOME must point to Android NDK ${ndkVersion}`,
			);
		}
		return configured;
	}
	const sdkRoots = [
		process.env.ANDROID_HOME,
		process.env.ANDROID_SDK_ROOT,
		path.join(homedir(), "Android", "sdk"),
		path.join(homedir(), "Library", "Android", "Sdk"),
	].filter((candidate) => candidate !== undefined);
	for (const sdkRoot of sdkRoots) {
		const candidate = validateNdk(path.join(sdkRoot, "ndk", ndkVersion));
		if (candidate !== null) return candidate;
	}
	throw new Error(
		`Android NDK ${ndkVersion} was not found; set ANDROID_NDK_HOME`,
	);
}

function findStaticLibrary(directory) {
	const entries = readdirSync(directory, { withFileTypes: true });
	for (const entry of entries) {
		const candidate = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			const nested = findStaticLibrary(candidate);
			if (nested !== null) return nested;
		} else if (entry.isFile() && entry.name === "libghostty-vt.a") {
			try {
				return realpathSync(candidate);
			} catch {}
		}
	}
	return null;
}

const manifestPath = path.join(vendorRoot, "manifest.json");
let previousManifest = null;
if (existsSync(manifestPath)) {
	try {
		previousManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		// A partial or corrupt manifest is a cache miss, never trusted provenance.
	}
}
const artifactPathForAbi = (abi) => `lib/${abi}/libghostty-vt.a`;
const manifestMatchesRecipe = (manifest) =>
	manifest !== null &&
	manifest.revision === revision &&
	manifest.zigVersion === zigVersion &&
	manifest.ndkVersion === ndkVersion &&
	manifest.androidApi === androidApi &&
	manifest.buildRecipeVersion === buildRecipeVersion &&
	manifest.simd === false &&
	manifest.seed === 0 &&
	JSON.stringify(manifest.deterministicPaths) ===
		JSON.stringify(deterministicPaths) &&
	typeof manifest.buildHost === "string" &&
	typeof manifest.zigDistribution === "string" &&
	/^[a-f0-9]{64}$/.test(manifest.zigArchiveSha256) &&
	/^[a-f0-9]{64}$/.test(manifest.zigBinarySha256);
const artifactIsVerified = (abi, manifest = previousManifest) => {
	const relative = artifactPathForAbi(abi);
	const output = path.join(vendorRoot, relative);
	return (
		manifestMatchesRecipe(manifest) &&
		Array.isArray(manifest.abis) &&
		manifest.abis.includes(abi) &&
		existsSync(output) &&
		manifest.artifacts?.[relative] === sha256(output) &&
		artifactIsPortable(output)
	);
};

function supportingArtifactsAreVerified(manifest = previousManifest) {
	if (!manifestMatchesRecipe(manifest)) return false;
	const include = path.join(vendorRoot, "include");
	const license = path.join(vendorRoot, "LICENSE");
	const revisionFile = path.join(vendorRoot, "REVISION");
	try {
		return (
			manifest.artifacts?.["include/**"] === treeSha256(include) &&
			manifest.artifacts?.LICENSE === sha256(license) &&
			readFileSync(revisionFile, "utf8").trim() === revision
		);
	} catch {
		return false;
	}
}

function buildAbi(abi, buildSource, buildZig) {
	const prefix = path.join(deterministicPaths.output, abi);
	run(
		buildZig,
		[
			"build",
			"--seed",
			"0",
			"--global-cache-dir",
			deterministicPaths.globalCache,
			"-Demit-lib-vt=true",
			`-Dtarget=${targetForAbi.get(abi)}`,
			"-Doptimize=ReleaseSmall",
			"-Dstrip=true",
			"-Dsimd=false",
			`-Dlib-version-string=0.1.0-dev+${revision}`,
			"-p",
			prefix,
		],
		{
			cwd: buildSource,
			env: {
				...process.env,
				ANDROID_NDK_HOME: deterministicPaths.ndk,
			},
		},
	);
	const library = findStaticLibrary(prefix);
	if (library === null) {
		throw new Error(`Ghostty did not emit a static Android library for ${abi}`);
	}
	if (!artifactIsPortable(library)) {
		throw new Error(`${abi} Ghostty archive embeds a host-specific build path`);
	}
	return library;
}

function copyFileAtomically(sourceFile, targetFile) {
	const partial = `${targetFile}.partial-${process.pid}`;
	mkdirSync(path.dirname(targetFile), { recursive: true });
	rmSync(partial, { force: true });
	try {
		copyFileSync(sourceFile, partial);
		renameSync(partial, targetFile);
	} finally {
		rmSync(partial, { force: true });
	}
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

function prepareArtifacts() {
	const force = process.argv.includes("--force");
	if (
		!force &&
		supportingArtifactsAreVerified() &&
		requestedAbis.every((abi) => artifactIsVerified(abi))
	) {
		console.log(
			`Verified Ghostty ${revision.slice(0, 12)} for ${requestedAbis.join(", ")}`,
		);
		return;
	}

	let ownsGlobalCache = false;
	let ownsNdk = false;
	let ownsOutput = false;
	let buildSource;
	let buildZig;
	let releaseBootstrap;
	try {
		const ndk = findNdk();
		if (existsSync(deterministicPaths.globalCache)) {
			throw new Error(
				`Deterministic Ghostty build path is already in use: ${deterministicPaths.globalCache}`,
			);
		}
		mkdirSync(deterministicPaths.globalCache, { recursive: false });
		ownsGlobalCache = true;
		if (existsSync(deterministicPaths.ndk)) {
			throw new Error(
				`Deterministic Ghostty build path is already in use: ${deterministicPaths.ndk}`,
			);
		}
		symlinkSync(ndk, deterministicPaths.ndk, "dir");
		ownsNdk = true;

		releaseBootstrap = bootstrap.prepare();
		if (
			sha256(path.join(sourceRoot, "LICENSE")) !==
			sha256(path.join(provenanceRoot, "LICENSE"))
		) {
			throw new Error(
				"Repository Ghostty license does not match pinned source",
			);
		}

		if (existsSync(deterministicPaths.output)) {
			throw new Error(
				`Deterministic Ghostty build path is already in use: ${deterministicPaths.output}`,
			);
		}
		mkdirSync(deterministicPaths.output, { recursive: false });
		ownsOutput = true;
		buildSource = makeDeterministicSource();
		buildZig = makeDeterministicZig();

		const freshlyBuilt = new Map();
		for (const abi of requestedAbis) {
			if (force || !artifactIsVerified(abi)) {
				freshlyBuilt.set(abi, buildAbi(abi, buildSource, buildZig));
			}
		}
		for (const [abi, library] of freshlyBuilt) {
			copyFileAtomically(
				library,
				path.join(vendorRoot, artifactPathForAbi(abi)),
			);
		}

		mkdirSync(vendorRoot, { recursive: true });
		replaceDirectoryAtomically(
			path.join(sourceRoot, "include"),
			path.join(vendorRoot, "include"),
		);
		copyFileAtomically(
			path.join(provenanceRoot, "LICENSE"),
			path.join(vendorRoot, "LICENSE"),
		);
		const revisionPartial = path.join(
			vendorRoot,
			`REVISION.partial-${process.pid}`,
		);
		writeFileSync(revisionPartial, `${revision}\n`);
		renameSync(revisionPartial, path.join(vendorRoot, "REVISION"));

		const verifiedAbis = Array.from(targetForAbi.keys()).filter(
			(abi) => freshlyBuilt.has(abi) || artifactIsVerified(abi),
		);
		const artifacts = Object.fromEntries([
			["include/**", treeSha256(path.join(vendorRoot, "include"))],
			["LICENSE", sha256(path.join(vendorRoot, "LICENSE"))],
			...verifiedAbis.map((abi) => {
				const relative = artifactPathForAbi(abi);
				return [relative, sha256(path.join(vendorRoot, relative))];
			}),
		]);
		const manifestPartial = `${manifestPath}.partial-${process.pid}`;
		writeFileSync(
			manifestPartial,
			`${JSON.stringify(
				{
					androidApi,
					artifacts,
					abis: verifiedAbis,
					buildHost: `${hostArchitecture}-${hostPlatform}`,
					buildRecipeVersion,
					deterministicPaths,
					ndkVersion,
					revision,
					seed: 0,
					simd: false,
					zigArchiveSha256: expectedZigArchiveSha256,
					zigBinarySha256: sha256(buildZig),
					zigDistribution,
					zigVersion,
				},
				null,
				"\t",
			)}\n`,
		);
		renameSync(manifestPartial, manifestPath);
	} finally {
		releaseBootstrap?.();
		if (buildSource !== undefined) {
			rmSync(buildSource, { recursive: true, force: true });
		}
		if (buildZig !== undefined) {
			rmSync(path.dirname(buildZig), { recursive: true, force: true });
		}
		if (ownsOutput) {
			rmSync(deterministicPaths.output, { recursive: true, force: true });
		}
		if (ownsNdk) {
			rmSync(deterministicPaths.ndk, { force: true });
		}
		if (ownsGlobalCache) {
			rmSync(deterministicPaths.globalCache, {
				recursive: true,
				force: true,
			});
		}
	}

	console.log(
		`Prepared Ghostty ${revision.slice(0, 12)} for ${requestedAbis.join(", ")}`,
	);
}

prepareArtifacts();
