import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import afterPack, { stageCursorHelpers } from "./cursor-sdk-package.mjs";

const require = createRequire(import.meta.url);

async function sdkLocator(runtime) {
	const source = await readFile(require.resolve("@cursor/sdk"), "utf8");
	const key = "./src/agent/platform-package-locator.ts";
	const start = source.indexOf(`"${key}"(`);
	assert.notEqual(start, -1, "SDK helper locator module must exist");
	const end = source.indexOf('},"./src/', start);
	assert.notEqual(end, -1, "SDK helper locator module boundary must exist");
	const modules = runInNewContext(`({${source.slice(start, end + 1)}})`, {
		process: runtime,
	});
	const exports = {};
	const load = Object.assign((name) => require(name), {
		d: (target, getters) => {
			for (const [name, get] of Object.entries(getters))
				Object.defineProperty(target, name, { get });
		},
	});
	modules[key]({}, exports, load);
	assert.equal(
		typeof exports.hQ,
		"function",
		"SDK binary locator export must exist",
	);
	return exports.hQ;
}

for (const [platform, archive] of [
	["darwin", "app.asar.unpacked"],
	["darwin", "app-arm64.asar.unpacked"],
	["linux", "app.asar.unpacked"],
]) {
	// The POSIX locator checks executable permission bits, unavailable on NTFS.
	test(`packaged ${platform} ${archive} SDK finds nested helpers without a script argv`, {
		skip: process.platform === "win32",
	}, async () => {
		const root = await mkdtemp(join(tmpdir(), "zuse-cursor-package-"));
		try {
			const contents = join(root, "app", "Contents");
			const resources = join(contents, "Resources");
			const name = `sdk-${platform}-arm64`;
			const nested = join(
				resources,
				`${archive}/node_modules/@cursor/sdk/node_modules/@cursor`,
				name,
				"bin",
			);
			await mkdir(nested, { recursive: true });
			for (const binary of ["cursorsandbox", "rg"]) {
				await writeFile(join(nested, binary), "#!/bin/sh\nexit 0\n", {
					mode: 0o755,
				});
			}
			const locate = await sdkLocator({
				platform,
				arch: "arm64",
				argv: ["Zuse"],
				execPath: join(contents, platform === "darwin" ? "MacOS/Zuse" : "Zuse"),
			});
			const excludedWorkspaceDir = join(root, "project");
			assert.equal(
				locate({ binaryName: "cursorsandbox", excludedWorkspaceDir }),
				undefined,
			);
			await stageCursorHelpers(contents, resources, platform);
			for (const binary of ["cursorsandbox", "rg"]) {
				assert.equal(
					locate({ binaryName: binary, excludedWorkspaceDir }),
					join(contents, "node_modules/@cursor", name, "bin", binary),
				);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

test("packaging fails when helpers are missing", async () => {
	const root = await mkdtemp(join(tmpdir(), "zuse-cursor-package-"));
	try {
		await assert.rejects(
			stageCursorHelpers(root, join(root, "Resources"), "darwin"),
			/No Cursor SDK helpers/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("universal packaging stages both architectures only after merging", async () => {
	const { Arch } = await import("electron-builder");
	const root = await mkdtemp(join(tmpdir(), "zuse-cursor-universal-"));
	try {
		const contents = join(root, "Zuse.app", "Contents");
		const context = {
			outDir: root,
			appOutDir: root,
			electronPlatformName: "darwin",
			arch: Arch.arm64,
			packager: {
				computeAppOutDir: (outDir, arch) => join(outDir, `mac-${Arch[arch]}`),
				appInfo: { productFilename: "Zuse" },
				info: {
					options: {
						targets: new Map([["mac", new Map([[Arch.universal, []]])]]),
					},
				},
			},
		};

		for (const arch of [Arch.arm64, Arch.x64]) {
			await afterPack({
				...context,
				arch,
				appOutDir: `${context.packager.computeAppOutDir(root, Arch.universal)}-${Arch[arch]}-temp`,
			});
		}
		for (const arch of ["arm64", "x64"]) {
			const bin = join(
				contents,
				"Resources",
				`app-${arch}.asar.unpacked/node_modules/@cursor/sdk/node_modules/@cursor/sdk-darwin-${arch}/bin`,
			);
			await mkdir(bin, { recursive: true });
			for (const name of ["rg", "cursorsandbox"])
				await writeFile(join(bin, name), arch, { mode: 0o755 });
		}
		await afterPack({ ...context, arch: Arch.universal });
		for (const arch of ["arm64", "x64"]) {
			assert.equal(
				await readFile(
					join(
						contents,
						`node_modules/@cursor/sdk-darwin-${arch}/bin/cursorsandbox`,
					),
					"utf8",
				),
				arch,
			);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

for (const architecture of ["arm64", "x64"]) {
	test(`stages standalone ${architecture} helpers alongside a universal target`, async () => {
		const { Arch } = await import("electron-builder");
		const root = await mkdtemp(join(tmpdir(), "zuse-cursor-mixed-"));
		try {
			const arch = Arch[architecture];
			const appOutDir = join(root, `mac-${architecture}`);
			const contents = join(appOutDir, "Zuse.app", "Contents");
			const packageName = `sdk-darwin-${architecture}`;
			const bin = join(
				contents,
				"Resources",
				"app.asar.unpacked/node_modules/@cursor/sdk/node_modules/@cursor",
				packageName,
				"bin",
			);
			await mkdir(bin, { recursive: true });
			for (const name of ["rg", "cursorsandbox"]) {
				await writeFile(join(bin, name), architecture, { mode: 0o755 });
			}
			await afterPack({
				outDir: root,
				appOutDir,
				arch,
				electronPlatformName: "darwin",
				packager: {
					computeAppOutDir: (outDir, targetArch) =>
						join(outDir, `mac-${Arch[targetArch]}`),
					appInfo: { productFilename: "Zuse" },
					info: {
						options: {
							targets: new Map([
								[
									"mac",
									new Map([
										[Arch.universal, []],
										[arch, []],
									]),
								],
							]),
						},
					},
				},
			});
			for (const name of ["rg", "cursorsandbox"]) {
				assert.equal(
					await readFile(
						join(contents, "node_modules/@cursor", packageName, "bin", name),
						"utf8",
					),
					architecture,
				);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

test("Windows stages executable-suffixed helpers from the packaged SDK", async () => {
	const root = await mkdtemp(join(tmpdir(), "zuse Windows ü-"));
	try {
		const resources = join(root, "resources");
		const source = join(
			resources,
			"app.asar.unpacked/node_modules/@cursor/sdk/node_modules/@cursor/sdk-win32-x64/bin",
		);
		await mkdir(source, { recursive: true });
		for (const name of ["cursorsandbox.exe", "rg.exe"])
			await writeFile(join(source, name), "fixture");
		const locate = await sdkLocator({
			platform: "win32",
			arch: "x64",
			argv: ["Zuse.exe"],
			execPath: join(root, "Zuse.exe"),
		});
		const excludedWorkspaceDir = join(root, "project");
		assert.equal(
			locate({ binaryName: "rg.exe", excludedWorkspaceDir }),
			undefined,
		);
		await stageCursorHelpers(root, resources, "win32", ["x64"]);
		for (const binaryName of ["cursorsandbox.exe", "rg.exe"])
			assert.equal(
				locate({ binaryName, excludedWorkspaceDir }),
				join(root, "node_modules/@cursor/sdk-win32-x64/bin", binaryName),
			);
		assert.equal(
			await readFile(
				join(root, "node_modules/@cursor/sdk-win32-x64/bin/rg.exe"),
				"utf8",
			),
			"fixture",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
