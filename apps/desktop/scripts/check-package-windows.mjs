import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32")
	throw new Error("Windows package validation must run on Windows");
const desktop = fileURLToPath(new URL("..", import.meta.url));
const archive = resolve(desktop, "../../dist/win-unpacked/resources/app.asar");
for (const [command, args, env] of [
	["bun", ["scripts/package-content-smoke.ts", archive], process.env],
	[
		resolve(desktop, "../../dist/win-unpacked/Zuse.exe"),
		["scripts/package-native-runtime-smoke.cjs", archive],
		{ ...process.env, ELECTRON_RUN_AS_NODE: "1" },
	],
]) {
	const result = spawnSync(command, args, {
		cwd: desktop,
		stdio: "inherit",
		env,
		timeout: 120_000,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
