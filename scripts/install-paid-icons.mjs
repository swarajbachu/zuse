import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { defaultPaidIconsDir, detectIconMode } = require("./icon-runtime.cjs");

if (!process.env.HUGEICONS_TOKEN?.trim()) {
	console.log("Using public icons (HUGEICONS_TOKEN is not set).");
	process.exit(0);
}

const result = spawnSync(
	"bun",
	[
		"install",
		"--cwd",
		defaultPaidIconsDir,
		"--frozen-lockfile",
		"--ignore-scripts",
	],
	{
		env: process.env,
		stdio: "inherit",
	},
);

if (result.error) throw result.error;
if (result.status !== 0) {
	throw new Error(
		`Paid icon installation failed with exit code ${result.status ?? "unknown"}. Check HUGEICONS_TOKEN and try again.`,
	);
}

if (detectIconMode() !== "paid") {
	throw new Error(
		"Paid icon installation completed without all required packages.",
	);
}

console.log("Installed licensed icon packages.");
