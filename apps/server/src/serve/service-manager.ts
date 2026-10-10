import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
	launchAgentDefinition,
	type ServeServiceName,
	serveServiceName,
	systemdUserDefinition,
} from "./service-definition.ts";

const execFileAsync = promisify(execFile);

export type SupportedServePlatform = "darwin" | "linux";

export interface ServeServicePaths {
	readonly platform: SupportedServePlatform;
	/** launchd label / systemd unit this install owns. */
	readonly service: ServeServiceName;
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
	readonly label: string;
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
				`${input.target}/${input.label}`,
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
	readonly sshManaged?: boolean;
}): ServeServicePaths => {
	const platform = input.platform ?? process.platform;
	const homeDir = input.homeDir ?? homedir();
	const service = serveServiceName({ sshManaged: input.sshManaged });
	if (platform === "darwin") {
		return {
			platform,
			service,
			definitionPath: join(
				homeDir,
				"Library",
				"LaunchAgents",
				`${service.label}.plist`,
			),
			dataDir: input.dataDir,
			logDir: join(input.dataDir, "logs"),
		};
	}
	if (platform === "linux") {
		return {
			platform,
			service,
			definitionPath: join(
				homeDir,
				".config",
				"systemd",
				"user",
				service.unitName,
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

/**
 * Earlier SSH bootstraps installed under the default `sh.zuse.serve` label.
 * Retire that install when it is SSH-managed so the host doesn't run twice;
 * a user's own `zuse serve` under the same label is never touched.
 */
const retireLegacySshService = async (
	paths: ServeServicePaths,
): Promise<void> => {
	const legacy: ServeServicePaths = {
		...paths,
		service: serveServiceName({ sshManaged: false }),
		definitionPath: join(
			dirname(paths.definitionPath),
			paths.platform === "darwin"
				? "sh.zuse.serve.plist"
				: "zuse-serve.service",
		),
	};
	const contents = await readFile(legacy.definitionPath, "utf8").catch(
		() => null,
	);
	if (contents === null || !contents.includes("--ssh-managed")) return;
	await uninstallServeService(legacy);
};

export const installServeService = async (input: {
	readonly executable: string;
	readonly paths: ServeServicePaths;
	readonly apiUrl?: string;
	readonly sshManaged?: boolean;
	readonly selfHosted?: boolean;
	readonly tailscale?: boolean;
	readonly noAccount?: boolean;
	readonly lan?: boolean;
	readonly host?: string;
	readonly port?: number;
}): Promise<ServeServiceStatus> => {
	const previouslyInstalled = await access(input.paths.definitionPath).then(
		() => true,
		() => false,
	);
	await mkdir(dirname(input.paths.definitionPath), { recursive: true });
	await mkdir(input.paths.logDir, { recursive: true, mode: 0o700 });
	await mkdir(input.paths.dataDir, { recursive: true, mode: 0o700 });
	if (input.paths.service.label === "sh.zuse.ssh") {
		await retireLegacySshService(input.paths);
	}

	if (input.paths.platform === "darwin") {
		const definition = launchAgentDefinition({
			service: input.paths.service,
			nodeExecutable: process.execPath,
			executable: input.executable,
			dataDir: input.paths.dataDir,
			logDir: input.paths.logDir,
			apiUrl: input.apiUrl,
			sshManaged: input.sshManaged,
			selfHosted: input.selfHosted,
			tailscale: input.tailscale,
			noAccount: input.noAccount,
			lan: input.lan,
			host: input.host,
			port: input.port,
		});
		await writeFile(input.paths.definitionPath, definition.contents, {
			mode: 0o600,
		});
		const target = launchctlTarget();
		await bootoutLaunchAgent({
			target,
			label: definition.label,
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
		service: input.paths.service,
		nodeExecutable: process.execPath,
		executable: input.executable,
		dataDir: input.paths.dataDir,
		logDir: input.paths.logDir,
		apiUrl: input.apiUrl,
		sshManaged: input.sshManaged,
		selfHosted: input.selfHosted,
		tailscale: input.tailscale,
		noAccount: input.noAccount,
		lan: input.lan,
		host: input.host,
		port: input.port,
	});
	await writeFile(input.paths.definitionPath, definition.contents, {
		mode: 0o600,
	});
	await run("systemctl", ["--user", "daemon-reload"]);
	await run("systemctl", ["--user", "enable", "--now", definition.unitName]);
	if (previouslyInstalled) {
		await run("systemctl", ["--user", "restart", definition.unitName]);
	}
	return { installed: true, running: true, durable: true };
};

export const startServeService = async (
	paths: ServeServicePaths,
	runCommand: ServeServiceCommandRunner = run,
): Promise<void> => {
	if (paths.platform === "darwin") {
		const target = launchctlTarget();
		const job = `${target}/${paths.service.label}`;
		await runCommand("launchctl", ["enable", job]);
		await runCommand("launchctl", [
			"bootstrap",
			target,
			paths.definitionPath,
		]).catch(async (cause) => {
			try {
				await runCommand("launchctl", ["print", job]);
			} catch {
				throw cause;
			}
		});
		await runCommand("launchctl", ["kickstart", "-k", job]);
		return;
	}
	await runCommand("systemctl", [
		"--user",
		"enable",
		"--now",
		paths.service.unitName,
	]);
};

export const stopServeService = async (
	paths: ServeServicePaths,
	runCommand: ServeServiceCommandRunner = run,
): Promise<void> => {
	if (paths.platform === "darwin") {
		const target = launchctlTarget();
		await runCommand("launchctl", [
			"disable",
			`${target}/${paths.service.label}`,
		]);
		await bootoutLaunchAgent({
			target,
			label: paths.service.label,
			definitionPath: paths.definitionPath,
			runCommand,
		});
		return;
	}
	await runCommand("systemctl", [
		"--user",
		"disable",
		"--now",
		paths.service.unitName,
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
			await run("launchctl", ["print", `${target}/${paths.service.label}`]);
		} else {
			await run("systemctl", [
				"--user",
				"is-active",
				"--quiet",
				paths.service.unitName,
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
			paths.service.unitName,
		]).catch(() => undefined);
	}
	await rm(paths.definitionPath, { force: true });
	if (paths.platform === "linux") {
		await run("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
	}
};
