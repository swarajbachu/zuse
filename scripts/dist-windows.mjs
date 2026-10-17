import { spawnSync } from "node:child_process";

if (process.platform !== "win32")
	throw new Error(
		"Build Windows artifacts on Windows so native modules match Electron",
	);
for (const args of [
	["run", "build:desktop"],
	[
		"run",
		"--cwd",
		"apps/desktop",
		process.argv.includes("--unsigned") ? "dist:win:unsigned" : "dist:win",
	],
]) {
	const result = spawnSync("bun", args, {
		env: { ...process.env, NODE_ENV: "production" },
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
