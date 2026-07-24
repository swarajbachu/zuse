import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const bundlePath = fileURLToPath(
	new URL("../dist-electron/main.cjs", import.meta.url),
);
const result = spawnSync(process.execPath, [bundlePath], {
	env: { ...process.env, ZUSE_MAIN_BUNDLE_SMOKE: "1" },
	encoding: "utf8",
});

if (result.error !== undefined) throw result.error;
if (result.status !== 0) {
	process.stderr.write(result.stderr);
	throw new Error(
		`Desktop main bundle failed startup smoke check (exit ${result.status ?? "unknown"})`,
	);
}
