import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const commands = vi.hoisted(() => [] as { file: string; args: string[] }[]);
vi.mock("node:child_process", () => ({
	execFile: (
		file: string,
		args: string[],
		_options: unknown,
		callback: (error: null, stdout: string, stderr: string) => void,
	) => {
		commands.push({ file, args });
		callback(null, "", "");
	},
}));

import { initializeExtension } from "../src/extension-init.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
	commands.length = 0;
});
const root = async () => {
	const path = await mkdtemp(join(tmpdir(), "adapter-init-"));
	roots.push(path);
	return path;
};
it("creates a server-only ACP project with literal argv and namespaced identity", async () => {
	const directory = await root();
	await initializeExtension({
		directory,
		id: "team-agent",
		name: 'Team "agent"',
		publisher: "Team",
		template: "acp",
		command: ["/path with spaces/agent", "--value=$(do-not-run)"],
		sdk: "/tmp/sdk.tgz",
	});
	const manifest = JSON.parse(
		await readFile(join(directory, "zuse-extension.json"), "utf8"),
	);
	expect(manifest).toMatchObject({
		zuseApi: "^1.2.0",
		capabilities: ["providers", "process"],
		contributions: ["provider"],
	});
	expect(manifest.client).toBeUndefined();
	const source = await readFile(join(directory, "src/index.server.ts"), "utf8");
	expect(source).toContain('id: "team-agent.agent"');
	expect(source).toContain(
		'command: ["/path with spaces/agent","--value=$(do-not-run)"]',
	);
	expect(await readdir(join(directory, "src"))).toEqual(["index.server.ts"]);
	expect(commands).toEqual([
		{
			file: "npm",
			args: ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
		},
		{ file: "npm", args: ["run", "check-types"] },
	]);
});
it.each([
	undefined,
	[],
	"agent --acp",
	[""],
	["agent", 42],
])("rejects invalid ACP commands before writing or running anything", async (command) => {
	const directory = await root();
	await expect(
		initializeExtension({
			directory,
			id: "agent",
			name: "Agent",
			publisher: "Team",
			template: "acp",
			command,
		}),
	).rejects.toThrow("--command");
	expect(await readdir(directory)).toEqual([]);
	expect(commands).toEqual([]);
});
