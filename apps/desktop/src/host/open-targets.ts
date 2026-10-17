import { constants } from "node:fs";
import { access } from "node:fs/promises";
import Path from "node:path";

import type { HostPlatform } from "@zuse/contracts";
import { spawn } from "@zuse/utils/spawn-command";

export type PortableOpenTarget = {
	readonly id: string;
	readonly label: string;
	readonly command: string | null;
	readonly args: (path: string) => ReadonlyArray<string>;
};

export const terminalShellCommand = (path: string): ReadonlyArray<string> => [
	"-e",
	"sh",
	"-c",
	`cd -- "$1" && exec "\${SHELL:-/bin/sh}" -l`,
	"zuse-terminal",
	path,
];

export const ghosttyWorkingDirectoryArgs = (
	path: string,
): ReadonlyArray<string> => [`--working-directory=${path}`];

export type PortableOpenTargetView = {
	readonly id: string;
	readonly label: string;
	readonly available: boolean;
	readonly iconDataUrl: null;
};

const linuxTargets: ReadonlyArray<PortableOpenTarget> = [
	{
		id: "finder",
		label: "Files",
		command: null,
		args: () => [],
	},
	{
		id: "cursor",
		label: "Cursor",
		command: "cursor",
		args: (path) => [path],
	},
	{
		id: "vscode",
		label: "VS Code",
		command: "code",
		args: (path) => [path],
	},
	{
		id: "windsurf",
		label: "Windsurf",
		command: "windsurf",
		args: (path) => [path],
	},
	{
		id: "zed",
		label: "Zed",
		command: "zed",
		args: (path) => [path],
	},
	{
		id: "ghostty",
		label: "Ghostty",
		command: "ghostty",
		args: ghosttyWorkingDirectoryArgs,
	},
	{
		id: "terminal",
		label: "Terminal",
		command: "x-terminal-emulator",
		args: terminalShellCommand,
	},
];

const windowsTargets: ReadonlyArray<PortableOpenTarget> = [
	{
		id: "finder",
		label: "File Explorer",
		command: null,
		args: () => [],
	},
	{
		id: "cursor",
		label: "Cursor",
		command: "cursor",
		args: (path) => [path],
	},
	{
		id: "vscode",
		label: "VS Code",
		command: "code",
		args: (path) => [path],
	},
	{
		id: "windsurf",
		label: "Windsurf",
		command: "windsurf",
		args: (path) => [path],
	},
	{
		id: "terminal",
		label: "Windows Terminal",
		command: "wt",
		args: (path) => ["-d", path],
	},
];

const resolveExecutableOnPath = async (
	command: string,
): Promise<string | null> => {
	const path = process.env.PATH;
	if (path === undefined) return null;
	const extensions =
		process.platform === "win32"
			? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
			: [""];
	for (const directory of path.split(Path.delimiter)) {
		for (const extension of extensions) {
			try {
				await access(
					Path.join(directory, `${command}${extension}`),
					constants.X_OK,
				);
				return Path.join(directory, `${command}${extension}`);
			} catch {}
		}
	}
	return null;
};

export const executableOnPath = async (command: string): Promise<boolean> =>
	(await resolveExecutableOnPath(command)) !== null;

const definitionsFor = (
	platform: HostPlatform,
): ReadonlyArray<PortableOpenTarget> =>
	platform === "linux"
		? linuxTargets
		: platform === "win32"
			? windowsTargets
			: [];

export const listPortableOpenTargets = async (
	platform: HostPlatform,
): Promise<ReadonlyArray<PortableOpenTargetView>> =>
	Promise.all(
		definitionsFor(platform).map(async (target) => ({
			id: target.id,
			label: target.label,
			available:
				target.command === null || (await executableOnPath(target.command)),
			iconDataUrl: null,
		})),
	);

export const openPathWithPortableTarget = async (
	platform: HostPlatform,
	targetId: string,
	path: string,
): Promise<"reveal" | "opened" | "unavailable"> => {
	const target = definitionsFor(platform).find(({ id }) => id === targetId);
	if (target === undefined) return "unavailable";
	if (target.command === null) return "reveal";
	const executable = await resolveExecutableOnPath(target.command);
	if (executable === null) return "unavailable";
	await new Promise<void>((resolve, reject) => {
		const child = spawn(executable, target.args(path), {
			detached: true,
			stdio: "ignore",
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
	return "opened";
};
