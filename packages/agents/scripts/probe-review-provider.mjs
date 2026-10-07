import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

// Reconnaissance only: never start a session, authenticate, or call inference.
const [provider, executable] = process.argv.slice(2);
if (
	!["claude", "codex"].includes(provider) ||
	!executable ||
	!isAbsolute(executable)
) {
	console.error(
		"Usage: node probe-review-provider.mjs <claude|codex> <absolute-binary-path>",
	);
	process.exit(1);
}
const binary = await realpath(executable);
const digest = createHash("sha256");
for await (const chunk of createReadStream(binary)) digest.update(chunk);
const inspect = (args) => {
	const result = spawnSync(binary, args, {
		cwd: "/tmp",
		env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
		encoding: "utf8",
		timeout: 10_000,
		maxBuffer: 256 * 1024,
	});
	if (result.error || result.status !== 0) {
		throw new Error(
			`Inspection failed: ${args.join(" ")} (exit ${result.status})`,
		);
	}
	return result.stdout.trim();
};
const version = inspect(["--version"]);
const help = inspect(
	provider === "codex" ? ["app-server", "--help"] : ["--help"],
);
const candidates =
	provider === "claude"
		? [
				"--tools",
				"--restricted",
				"--safe-mode",
				"--bare",
				"--setting-sources",
				"--strict-mcp-config",
			]
		: ["--strict-config", "--disable", "--config"];
console.log(
	JSON.stringify(
		{
			provider,
			binary,
			sha256: digest.digest("hex"),
			version,
			advertisedFlags: candidates.filter((flag) => help.includes(flag)),
			eligibility: "blocked",
			note: "Help flags are not confinement evidence. No authentication or inference was attempted.",
		},
		null,
		2,
	),
);
