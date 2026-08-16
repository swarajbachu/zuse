import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import Path from "node:path";

import type { HostPlatform } from "@zuse/contracts";

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

// This is intentionally explicit: Windows can share the IPC contract without
// silently inheriting Unix launch semantics when its adapter is implemented.
const windowsTargets: ReadonlyArray<PortableOpenTarget> = [
	{
		id: "finder",
		label: "File Explorer",
		command: null,
		args: () => [],
	},
];

export const executableOnPath = async (command: string): Promise<boolean> => {
	const path = process.env.PATH;
	if (path === undefined) return false;
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
				return true;
			} catch {
				// Continue searching the remaining PATH entries.
			}
		}
	}
	return false;
};

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
	if (!(await executableOnPath(target.command))) return "unavailable";
	await new Promise<void>((resolve, reject) => {
		const child = spawn(target.command as string, target.args(path), {
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
