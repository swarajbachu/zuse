import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const output = join(root, "apps/server/dist-review");
const require = createRequire(import.meta.url);
if (process.platform !== "linux" || process.arch !== "x64")
	throw new Error("Review image requires Linux x64 build");
await mkdir(output, { recursive: true });
const external = [
	"jsonc-parser",
	"tree-sitter",
	"tree-sitter-javascript",
	"tree-sitter-json",
	"tree-sitter-typescript",
	"node-gyp-build",
	"node-addon-api",
];
const build = spawnSync(
	"bun",
	[
		"build",
		"apps/server/src/review/worker-cli.ts",
		"--target",
		"node",
		...external.flatMap((name) => ["--external", name]),
		"--outfile",
		join(output, "review-worker.mjs"),
	],
	{ cwd: root, stdio: "inherit" },
);
if (build.status !== 0) throw new Error("Review worker bundle failed");
for (const name of external) {
	const packageRoot = dirname(require.resolve(`${name}/package.json`));
	await cp(packageRoot, join(output, "node_modules", name), {
		recursive: true,
	});
}
const binary = join(
	root,
	"node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
);
await cp(binary, join(output, "claude"));
const version = JSON.parse(
	await readFile(
		join(root, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"),
		"utf8",
	),
).version;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
await writeFile(
	join(output, "manifest.json"),
	JSON.stringify(
		{
			protocol: 1,
			provider: "claude",
			sdkVersion: version,
			workerSha256: digest(await readFile(join(output, "review-worker.mjs"))),
			binarySha256: digest(await readFile(binary)),
			releaseApproved: false,
		},
		null,
		2,
	),
);
const check = spawnSync(
	process.execPath,
	[join(output, "review-worker.mjs"), "--check"],
	{ cwd: output, env: { PATH: process.env.PATH }, stdio: "inherit" },
);
if (check.status !== 0) throw new Error("Review worker smoke check failed");
