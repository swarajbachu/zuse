import { constants } from "node:fs";
import { access, cp, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Stage helpers where the SDK's executable-relative lookup can reach them. */
export async function stageCursorHelpers(
	contentsRoot,
	resourcesRoot,
	platform,
	requiredArchitectures = [],
) {
	const archives = [
		"app.asar.unpacked",
		"app-arm64.asar.unpacked",
		"app-x64.asar.unpacked",
	];
	const scopes = archives.flatMap((archive) => {
		const modules = join(resourcesRoot, archive, "node_modules", "@cursor");
		return [modules, join(modules, "sdk", "node_modules", "@cursor")];
	});
	const staged = new Set();
	for (const scope of scopes) {
		const entries = await readdir(scope).catch((error) => {
			if (error.code === "ENOENT") return [];
			throw error;
		});
		for (const name of entries) {
			if (!name.startsWith(`sdk-${platform}-`) || staged.has(name)) continue;
			const source = join(scope, name, "bin");
			for (const binary of ["cursorsandbox", "rg"]) {
				await access(
					join(source, platform === "win32" ? `${binary}.exe` : binary),
					platform === "win32" ? constants.F_OK : constants.X_OK,
				);
			}
			const target = join(contentsRoot, "node_modules", "@cursor", name, "bin");
			await mkdir(target, { recursive: true });
			await cp(source, target, { recursive: true });
			staged.add(name);
		}
	}
	for (const arch of requiredArchitectures) {
		if (!staged.has(`sdk-${platform}-${arch}`)) {
			throw new Error(`No Cursor SDK helpers packaged for ${platform}-${arch}`);
		}
	}
	if (staged.size === 0)
		throw new Error(`No Cursor SDK helpers packaged for ${platform}`);
}

/** Stage final app helpers before signing, leaving temporary universal slices untouched. */
export default async function afterPack(context) {
	const platform = context.electronPlatformName;
	if (!["darwin", "linux", "win32"].includes(platform)) return;
	const { Arch } = await import("electron-builder");
	// Universal builds run this hook for each temporary architecture and again
	// after merging. Stage only after the merge, before signing, so architecture
	// specific helpers do not enter Electron's Mach-O merge pass.
	if (platform === "darwin" && context.arch !== Arch.universal) {
		// electron-builder 25 names universal slices from the universal output
		// directory, not from the independently requested architecture output.
		const universalOutput = context.packager.computeAppOutDir(
			context.outDir,
			Arch.universal,
		);
		const sliceOutput = `${universalOutput}-${Arch[context.arch]}-temp`;
		if (resolve(context.appOutDir) === resolve(sliceOutput)) return;
	}
	const contentsRoot =
		platform === "darwin"
			? join(
					context.appOutDir,
					`${context.packager.appInfo.productFilename}.app`,
					"Contents",
				)
			: context.appOutDir;
	const resourcesRoot = join(
		contentsRoot,
		platform === "darwin" ? "Resources" : "resources",
	);
	await stageCursorHelpers(
		contentsRoot,
		resourcesRoot,
		platform,
		context.arch === Arch.universal ? ["arm64", "x64"] : [Arch[context.arch]],
	);
}
