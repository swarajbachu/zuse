import { execFile } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
	launchAgentDefinition,
	systemdUserDefinition,
} from "./service-definition.ts";

const execFileAsync = promisify(execFile);

export type SupportedServePlatform = "darwin" | "linux";

export interface ServeServicePaths {
	readonly platform: SupportedServePlatform;
	readonly definitionPath: string;
	readonly dataDir: string;
	readonly logDir: string;
}

export interface ServeServiceStatus {
	readonly installed: boolean;
	readonly running: boolean;
	readonly durable: boolean;
	readonly detail?: string;
}

export class UnsupportedServiceManagerError extends Error {
	readonly name = "UnsupportedServiceManagerError";
}

const fileExists = async (path: string): Promise<boolean> => {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
};

const run = async (
	executable: string,
	args: ReadonlyArray<string>,
): Promise<{ readonly stdout: string; readonly stderr: string }> => {
	const result = await execFileAsync(executable, [...args], {
		encoding: "utf8",
	});
	return { stdout: result.stdout, stderr: result.stderr };
};

export type ServeServiceCommandRunner = typeof run;

const isMissingLaunchctlService = (cause: unknown): boolean => {
	if (typeof cause !== "object" || cause === null) return false;
	const error = cause as { readonly code?: unknown; readonly stderr?: unknown };
	return (
		error.code === 113 &&
		typeof error.stderr === "string" &&
		error.stderr.includes("Could not find service")
	);
};

const bootoutLaunchAgent = async (input: {
	readonly target: string;
	readonly definitionPath: string;
	readonly runCommand: ServeServiceCommandRunner;
}): Promise<void> => {
	try {
		await input.runCommand("launchctl", [
			"bootout",
			input.target,
			input.definitionPath,
		]);
	} catch (cause) {
		try {
			await input.runCommand("launchctl", [
				"print",
				`${input.target}/sh.zuse.serve`,
			]);
		} catch (probeCause) {
			if (isMissingLaunchctlService(probeCause)) return;
		}
		throw cause;
	}
};

export const resolveServeServicePaths = (input: {
	readonly platform?: NodeJS.Platform;
	readonly homeDir?: string;
	readonly dataDir: string;
}): ServeServicePaths => {
	const platform = input.platform ?? process.platform;
	const homeDir = input.homeDir ?? homedir();
	if (platform === "darwin") {
		return {
			platform,
			definitionPath: join(
				homeDir,
				"Library",
				"LaunchAgents",
				"sh.zuse.serve.plist",
			),
			dataDir: input.dataDir,
			logDir: join(input.dataDir, "logs"),
		};
	}
	if (platform === "linux") {
		return {
			platform,
			definitionPath: join(
				homeDir,
				".config",
				"systemd",
				"user",
				"zuse-serve.service",
			),
			dataDir: input.dataDir,
			logDir: join(input.dataDir, "logs"),
		};
	}
	throw new UnsupportedServiceManagerError(
		`Zuse Serve background installation is not supported on ${platform}.`,
	);
};

const launchctlTarget = (): string => {
	const uid = process.getuid?.();
	if (uid === undefined) {
		throw new UnsupportedServiceManagerError(
			"Unable to determine the current macOS user.",
		);
	}
	return `gui/${uid}`;
};

const isSystemdUserAvailable = async (): Promise<boolean> => {
	try {
		await run("systemctl", ["--user", "show-environment"]);
		return true;
	} catch {
		return false;
	}
};

export const installServeService = async (input: {
	readonly executable: string;
	readonly paths: ServeServicePaths;
	readonly relayUrl?: string;
}): Promise<ServeServiceStatus> => {
	await mkdir(dirname(input.paths.definitionPath), { recursive: true });
	await mkdir(input.paths.logDir, { recursive: true, mode: 0o700 });
	await mkdir(input.paths.dataDir, { recursive: true, mode: 0o700 });

	if (input.paths.platform === "darwin") {
		const definition = launchAgentDefinition({
			nodeExecutable: process.execPath,
			executable: input.executable,
			dataDir: input.paths.dataDir,
			logDir: input.paths.logDir,
			relayUrl: input.relayUrl,
		});
		await writeFile(input.paths.definitionPath, definition.contents, {
			mode: 0o600,
		});
		const target = launchctlTarget();
		await bootoutLaunchAgent({
			target,
			definitionPath: input.paths.definitionPath,
			runCommand: run,
		});
		await run("launchctl", ["bootstrap", target, input.paths.definitionPath]);
		await run("launchctl", ["enable", `${target}/${definition.label}`]);
		await run("launchctl", [
			"kickstart",
			"-k",
			`${target}/${definition.label}`,
		]);
		return { installed: true, running: true, durable: true };
	}

	if (!(await isSystemdUserAvailable())) {
		throw new UnsupportedServiceManagerError(
			"This Linux session does not provide systemd user services.",
		);
	}
	const definition = systemdUserDefinition({
		nodeExecutable: process.execPath,
		executable: input.executable,
		dataDir: input.paths.dataDir,
		logDir: input.paths.logDir,
		relayUrl: input.relayUrl,
	});
	await writeFile(input.paths.definitionPath, definition.contents, {
		mode: 0o600,
	});
	await run("systemctl", ["--user", "daemon-reload"]);
	await run("systemctl", ["--user", "enable", "--now", definition.unitName]);
	return { installed: true, running: true, durable: true };
};

export const startServeService = async (
	paths: ServeServicePaths,
	runCommand: ServeServiceCommandRunner = run,
): Promise<void> => {
	if (paths.platform === "darwin") {
		const target = launchctlTarget();
		await runCommand("launchctl", ["enable", `${target}/sh.zuse.serve`]);
		await runCommand("launchctl", [
			"bootstrap",
			target,
			paths.definitionPath,
		]).catch(async (cause) => {
			try {
				await runCommand("launchctl", ["print", `${target}/sh.zuse.serve`]);
			} catch {
				throw cause;
			}
		});
		await runCommand("launchctl", [
			"kickstart",
			"-k",
			`${target}/sh.zuse.serve`,
		]);
		return;
	}
	await runCommand("systemctl", [
		"--user",
		"enable",
		"--now",
		"zuse-serve.service",
	]);
};

export const stopServeService = async (
	paths: ServeServicePaths,
	runCommand: ServeServiceCommandRunner = run,
): Promise<void> => {
	if (paths.platform === "darwin") {
		const target = launchctlTarget();
		await runCommand("launchctl", ["disable", `${target}/sh.zuse.serve`]);
		await bootoutLaunchAgent({
			target,
			definitionPath: paths.definitionPath,
			runCommand,
		});
		return;
	}
	await runCommand("systemctl", [
		"--user",
		"disable",
		"--now",
		"zuse-serve.service",
	]);
};

export const getServeServiceStatus = async (
	paths: ServeServicePaths,
): Promise<ServeServiceStatus> => {
	const installed = await fileExists(paths.definitionPath);
	if (!installed) return { installed: false, running: false, durable: true };
	try {
		if (paths.platform === "darwin") {
			const target = launchctlTarget();
			await run("launchctl", ["print", `${target}/sh.zuse.serve`]);
		} else {
			await run("systemctl", [
				"--user",
				"is-active",
				"--quiet",
				"zuse-serve.service",
			]);
		}
		return { installed: true, running: true, durable: true };
	} catch (cause) {
		return {
			installed: true,
			running: false,
			durable: true,
			detail: cause instanceof Error ? cause.message : String(cause),
		};
	}
};

export const uninstallServeService = async (
	paths: ServeServicePaths,
): Promise<void> => {
	if (paths.platform === "darwin") {
		await run("launchctl", [
			"bootout",
			launchctlTarget(),
			paths.definitionPath,
		]).catch(() => undefined);
	} else {
		await run("systemctl", [
			"--user",
			"disable",
			"--now",
			"zuse-serve.service",
		]).catch(() => undefined);
	}
	await rm(paths.definitionPath, { force: true });
	if (paths.platform === "linux") {
		await run("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
	}
};
