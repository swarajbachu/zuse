import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Run with `xvfb-run -a node apps/desktop/test/integration/html-visual-network.mjs` on Linux.
const temporary = await mkdtemp(join(tmpdir(), "zuse-visual-network-"));
const entry = join(temporary, "test.cjs");
const require = createRequire(import.meta.url);
try {
	// Electron's package is external so the test runs against the installed desktop runtime.
	execFileSync(
		"bun",
		[
			"build",
			resolve(import.meta.dirname, "html-visual-network.electron.ts"),
			"--target=node",
			"--format=cjs",
			"--external=electron",
			`--outfile=${entry}`,
		],
		{ stdio: "inherit" },
	);
	const child = spawn(require("electron"), ["--no-sandbox", entry], {
		stdio: "inherit",
		env: {
			...process.env,
			NODE_PATH: resolve(import.meta.dirname, "../../../../node_modules"),
		},
	});
	const code = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", resolve);
	});
	if (code !== 0) throw new Error(`Electron integration failed (${code})`);
} finally {
	await rm(temporary, { recursive: true, force: true });
}
