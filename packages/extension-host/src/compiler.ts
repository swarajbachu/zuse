import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { unpackedPath } from "@zuse/utils/unpacked-path";
import type { Plugin } from "esbuild";

const require = createRequire(import.meta.url);
const compiler = (): typeof import("esbuild") =>
	require(unpackedPath(require.resolve("esbuild")));

import type { CompiledExtension } from "./types.ts";

type Target = "client" | "server";

const moduleTarget = (specifier: string): Target | null => {
	if (/\.client(?:\.[cm]?[jt]sx?)?$/.test(specifier)) return "client";
	if (/\.server(?:\.[cm]?[jt]sx?)?$/.test(specifier)) return "server";
	return null;
};

const sourceBoundaryPlugin = (target: Target): Plugin => ({
	name: `zuse-extension-${target}-source-boundary`,
	setup(context) {
		context.onResolve({ filter: /^effect$/ }, () => ({
			path: "effect",
			namespace: "zuse-effect",
		}));
		context.onLoad({ filter: /.*/, namespace: "zuse-effect" }, () => ({
			contents: 'export { Schema } from "zuse:effect-runtime";',
			loader: "js",
		}));
		context.onResolve({ filter: /^zuse:effect-runtime$/ }, () => ({
			path: "effect",
			external: true,
		}));
		context.onResolve(
			{ filter: /^(?:@zuse\/extension-sdk(?:\/.*)?|@repo\/ui\/.*)$/ },
			(args) => {
				const allowed =
					target === "client"
						? [
								"@zuse/extension-sdk",
								"@zuse/extension-sdk/client",
								"@repo/ui/button",
								"@repo/ui/card",
								"@repo/ui/code",
								"@repo/ui/dither",
							]
						: ["@zuse/extension-sdk", "@zuse/extension-sdk/server"];
				return allowed.includes(args.path)
					? null
					: {
							errors: [
								{
									text: `Module is not provided by the ${target} runtime: ${args.path}`,
								},
							],
						};
			},
		);
		context.onResolve(
			{ filter: /\.(?:client|server)(?:\.[cm]?[jt]sx?)?$/ },
			(args) => {
				const imported = moduleTarget(args.path);
				if (imported === null || imported === target) return null;
				return {
					errors: [
						{
							text: `${imported}-only module cannot be imported into the ${target} extension bundle: ${args.path}`,
						},
					],
				};
			},
		);
	},
});

const factory = (source: string): string =>
	`(function(require){const module={exports:{}};const exports=module.exports;${source}\n;return module.exports;})`;

const compileTarget = async (entryPath: string | undefined, target: Target) => {
	if (!entryPath)
		return {
			bundle: factory("module.exports.default = () => () => {};"),
			css: "",
		};
	const result = await compiler().build({
		stdin: {
			contents: await readFile(entryPath, "utf8"),
			loader: "tsx",
			resolveDir: dirname(entryPath),
			sourcefile: entryPath,
		},
		bundle: true,
		jsx: "automatic",
		jsxImportSource: "react",
		outdir: "out",
		entryNames: target,
		format: "cjs",
		platform: target === "server" ? "node" : "browser",
		target: target === "server" ? "node22" : "chrome130",
		external:
			target === "client"
				? [
						"react",
						"react/jsx-runtime",
						"react-dom",
						"effect",
						"@hugeicons/react",
						"@repo/ui/button",
						"@repo/ui/card",
						"@repo/ui/code",
						"@repo/ui/dither",
						"@zuse/extension-sdk",
						"@zuse/extension-sdk/client",
					]
				: ["effect", "@zuse/extension-sdk", "@zuse/extension-sdk/server"],
		plugins: [sourceBoundaryPlugin(target)],
		define: {
			"globalThis.__ZUSE_EXTENSION_TARGET__": JSON.stringify(target),
		},
		write: false,
		logLevel: "silent",
		metafile: false,
	});
	const js =
		result.outputFiles.find((file) => file.path.endsWith("<stdout>")) ??
		result.outputFiles.find((file) => file.path.endsWith(".js"));
	if (!js)
		throw new Error(`Extension ${target} compilation produced no JavaScript.`);
	const css = result.outputFiles.find((file) => file.path.endsWith(".css"));
	return { bundle: factory(js.text), css: css?.text ?? "" };
};

export const compileExtension = async (
	entryPath: string | { client?: string; server?: string; entry?: string },
): Promise<CompiledExtension> => {
	const [client, server] = await Promise.all([
		compileTarget(
			typeof entryPath === "string"
				? entryPath
				: (entryPath.client ?? entryPath.entry),
			"client",
		),
		compileTarget(
			typeof entryPath === "string"
				? entryPath
				: (entryPath.server ?? entryPath.entry),
			"server",
		),
	]);
	return {
		clientBundle: client.bundle,
		clientCss: client.css,
		serverBundle: server.bundle,
	};
};
