import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const target = process.argv[2];
if (target !== "staging" && target !== "production") {
	console.error("Template target must be staging or production.");
	process.exit(1);
}

const { vcpuCount, memoryMib } = JSON.parse(
	readFileSync(new URL("./template-resources.json", import.meta.url), "utf8"),
);
const templateName =
	target === "production"
		? "zuse-cloud-sandbox-production"
		: "zuse-cloud-sandbox";
const result = spawnSync(
	"npx",
	[
		"--yes",
		"@e2b/cli@latest",
		"template",
		"create",
		templateName,
		"--path",
		"infra/cloud-sandboxes",
		"--cmd",
		"sleep infinity",
		"--ready-cmd",
		"true",
		"--cpu-count",
		String(vcpuCount),
		"--memory-mb",
		String(memoryMib),
	],
	{ stdio: "inherit" },
);

if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
