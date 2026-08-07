import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import {
	cp,
	mkdir,
	readdir,
	readFile,
	stat,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

import { WIRE_PROTOCOL_VERSION } from "@zuse/contracts";

const serverRoot = dirname(new URL(import.meta.url).pathname);
const packageRoot = dirname(serverRoot);
const workspaceRoot = dirname(dirname(packageRoot));
const outputRoot = join(packageRoot, "dist-cloud");
const runtimeRoot = join(outputRoot, "runtime");
const runtimeAssetName = process.env.ZUSE_RUNTIME_ASSET_NAME;
if (runtimeAssetName === undefined) {
	throw new Error("ZUSE_RUNTIME_ASSET_NAME is required");
}
if (!/^zuse-runtime-linux-x64-[a-f0-9]{40}\.tar\.gz$/u.test(runtimeAssetName)) {
	throw new Error(
		"ZUSE_RUNTIME_ASSET_NAME must contain the full source commit SHA",
	);
}
const archivePath = join(outputRoot, runtimeAssetName);
const packageJson = JSON.parse(
	await readFile(join(packageRoot, "package.json"), "utf8"),
);
const require = createRequire(join(packageRoot, "package.json"));

if (process.platform !== "linux" || process.arch !== "x64") {
	throw new Error("The cloud runtime must be built on Linux x64");
}

const run = (command, args, cwd = workspaceRoot) => {
	const result = spawnSync(command, args, { cwd, stdio: "inherit" });
	if (result.status !== 0) {
		throw new Error(`${command} exited with ${result.status ?? "no status"}`);
	}
};

run("bunx", ["tsdown", "--config", "tsdown.cloud.config.ts"], packageRoot);
const generatedModules = (await readdir(outputRoot)).filter((name) =>
	name.endsWith(".mjs"),
);
if (generatedModules.length !== 1 || generatedModules[0] !== "bin.mjs") {
	throw new Error(
		`Cloud runtime must be a single bundle; found ${generatedModules.join(", ")}`,
	);
}
const bundlePath = join(outputRoot, "bin.mjs");
const bundleSource = await readFile(bundlePath, "utf8");
if (
	/\b(?:from|import\s*\(|require\s*\()\s*["']keytar["']/u.test(bundleSource)
) {
	throw new Error("Cloud runtime unexpectedly imports keytar");
}
await mkdir(runtimeRoot, { recursive: true });
await cp(bundlePath, join(runtimeRoot, "bin.mjs"));
await cp(
	join(packageRoot, "scripts", "runtime-updater.mjs"),
	join(runtimeRoot, "runtime-updater.mjs"),
);
await cp(
	join(packageRoot, "scripts", "toolchain-reconciler.mjs"),
	join(runtimeRoot, "toolchain-reconciler.mjs"),
);
await cp(
	join(packageRoot, "scripts", "toolchain-manifest.json"),
	join(runtimeRoot, "toolchain-manifest.json"),
);

const nativePackages = [
	"bindings",
	"file-uri-to-path",
	"node-gyp-build",
	"node-pty",
	"tree-sitter",
	"tree-sitter-javascript",
	"tree-sitter-json",
	"tree-sitter-typescript",
];
for (const packageName of nativePackages) {
	let source = dirname(require.resolve(packageName));
	for (;;) {
		const candidate = join(source, "package.json");
		try {
			const metadata = JSON.parse(await readFile(candidate, "utf8"));
			if (metadata.name === packageName) break;
		} catch {
			// Keep walking: package exports often hide package.json itself.
		}
		const parent = dirname(source);
		if (parent === source) {
			throw new Error(`Could not resolve package root for ${packageName}`);
		}
		source = parent;
	}
	await cp(source, join(runtimeRoot, "node_modules", packageName), {
		recursive: true,
		filter: (entry) =>
			!entry.endsWith(".map") &&
			!entry.endsWith(".ts") &&
			!entry.includes("/test/") &&
			!entry.includes("/tests/"),
	});
}

await writeFile(
	join(runtimeRoot, "package.json"),
	`${JSON.stringify(
		{
			name: "@zuse/cloud-runtime",
			version: packageJson.version,
			private: true,
			type: "module",
			bin: { zuse: "./bin.mjs" },
		},
		null,
		2,
	)}\n`,
);

run("tar", ["-czf", archivePath, "-C", runtimeRoot, "."]);
const archive = await readFile(archivePath);
const sha256 = createHash("sha256").update(archive).digest("hex");
const toolchainManifestBytes = await readFile(
	join(runtimeRoot, "toolchain-manifest.json"),
);
const toolchainManifest = JSON.parse(toolchainManifestBytes);
const runtimeUrl = process.env.ZUSE_RUNTIME_URL;
if (runtimeUrl === undefined) {
	throw new Error("ZUSE_RUNTIME_URL is required");
}
if (new URL(runtimeUrl).protocol !== "https:") {
	throw new Error("ZUSE_RUNTIME_URL must use HTTPS");
}
const manifest = {
	channel: "stable",
	version: process.env.ZUSE_RUNTIME_VERSION ?? packageJson.version,
	url: runtimeUrl,
	architecture: "linux-x64",
	sha256,
	wireProtocol: { min: WIRE_PROTOCOL_VERSION, max: WIRE_PROTOCOL_VERSION },
	toolchain: {
		version: toolchainManifest.version,
		sha256: createHash("sha256").update(toolchainManifestBytes).digest("hex"),
	},
	sizeBytes: (await stat(archivePath)).size,
};

const privateJwk = process.env.ZUSE_RUNTIME_SIGNING_PRIVATE_JWK;
if (privateJwk === undefined) {
	throw new Error("ZUSE_RUNTIME_SIGNING_PRIVATE_JWK is required");
}
const signature = sign(
	null,
	Buffer.from(JSON.stringify(manifest)),
	createPrivateKey({ key: JSON.parse(privateJwk), format: "jwk" }),
).toString("base64url");
await writeFile(
	join(outputRoot, "stable-manifest.json"),
	`${JSON.stringify({ ...manifest, signature }, null, 2)}\n`,
);

console.log(
	JSON.stringify({
		archive: relative(workspaceRoot, archivePath),
		manifest: relative(workspaceRoot, join(outputRoot, "stable-manifest.json")),
		sha256,
		sizeBytes: manifest.sizeBytes,
	}),
);
