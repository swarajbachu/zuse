import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rebuild } from "@electron/rebuild";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const modules = ["node-pty", "keytar"];
const completed = new Set();
// electron-rebuild does not recognize bun.lock when detecting workspace roots.
// Without this boundary it reports success while finding zero hoisted modules.
const task = rebuild({
	buildPath: desktop,
	projectRootPath: resolve(desktop, "../.."),
	electronVersion: require("electron/package.json").version,
	onlyModules: modules,
	force: true,
	mode: "sequential",
});
task.lifecycle.on("module-done", (name) => {
	completed.add(name);
	console.log(`[native] rebuilt ${name}`);
});
await task;
for (const name of modules) {
	if (!completed.has(name))
		throw new Error(
			`Native rebuild did not find ${name}; run bun install from the repository root`,
		);
}
