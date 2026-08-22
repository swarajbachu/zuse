import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
	chmod,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { CloudWorkspaceSshAccess } from "@zuse/contracts";

/**
 * Desktop-side SSH access to cloud workspaces.
 *
 * Owns the managed key material and ssh configuration under `~/.zuse/ssh/`:
 * a dedicated keypair, one `Host zuse-*` block whose ProxyCommand runs the
 * bundled WebSocket bridge, per-workspace access tickets, and a single
 * marker-guarded `Include` line in the user's `~/.ssh/config` (required —
 * `vscode-remote://` URIs resolve hosts through ssh config, not CLI flags).
 */

const execFileAsync = promisify(execFile);

export interface CloudSshPrepared {
	readonly hostAlias: string;
	readonly sshCommand: string;
	readonly publicKey: string;
	readonly remotePath: string;
}

const INCLUDE_MARKER = "# Zuse cloud workspaces (managed include)";

const sshRoot = (): string => join(homedir(), ".zuse", "ssh");
const keyPath = (): string => join(sshRoot(), "id_ed25519");
const ticketsDir = (): string => join(sshRoot(), "tickets");
const bridgeDir = (): string => join(sshRoot(), "bridge");
const installedBridgePath = (): string =>
	join(bridgeDir(), "ssh-bridge-child.cjs");
const bridgeLauncherPath = (): string => join(bridgeDir(), "launch");
let infrastructureSetup: Promise<string> | null = null;

/** The managed ssh config that declares every `zuse-*` cloud host alias. */
export const cloudSshConfigPath = (): string => join(sshRoot(), "config");

export const cloudSshHostAlias = (workspaceId: string): string =>
	`zuse-${workspaceId}`;

const resolveBridgeScript = (): string => {
	const bundled = fileURLToPath(
		new URL("./ssh-bridge-child.cjs", import.meta.url),
	);
	const unpacked = bundled.replace(
		`${sep}app.asar${sep}`,
		`${sep}app.asar.unpacked${sep}`,
	);
	return existsSync(unpacked) ? unpacked : bundled;
};

const shellQuote = (value: string): string =>
	`'${value.replaceAll("'", `'"'"'`)}'`;

export interface CloudSshBridgeRuntime {
	readonly executable: string;
	readonly electronRunAsNode: boolean;
}

export const cloudSshBridgeLauncher = (
	runtime: CloudSshBridgeRuntime,
	bridgePath: string,
): string => {
	const environment = runtime.electronRunAsNode
		? "env ELECTRON_RUN_AS_NODE=1 "
		: "";
	return `#!/bin/sh\nexec ${environment}${shellQuote(runtime.executable)} ${shellQuote(bridgePath)} "$@"\n`;
};

export const resolveCloudSshBridgeRuntime = async (
	isPackaged: boolean,
): Promise<CloudSshBridgeRuntime> => {
	if (isPackaged) {
		return { executable: process.execPath, electronRunAsNode: true };
	}
	const { stdout } = await execFileAsync("node", ["-p", "process.execPath"]);
	const executable = stdout.trim();
	if (!isAbsolute(executable) || !existsSync(executable)) {
		throw new Error("Could not resolve a stable Node.js executable for SSH");
	}
	return { executable, electronRunAsNode: false };
};

/** Replace a private file without exposing a partially-written credential. */
export const atomicWritePrivateFile = async (
	path: string,
	contents: string | Buffer,
	mode: number,
): Promise<void> => {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
	try {
		await writeFile(temporaryPath, contents, { mode, flag: "wx" });
		await chmod(temporaryPath, mode);
		await rename(temporaryPath, path);
		await chmod(path, mode);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
};

export const pruneExpiredCloudSshTickets = async (
	directory = ticketsDir(),
	now = Date.now(),
): Promise<void> => {
	let names: string[];
	try {
		names = await readdir(directory);
	} catch {
		return;
	}
	await Promise.all(
		names
			.filter((name) => name.endsWith(".json"))
			.map(async (name) => {
				const path = join(directory, name);
				try {
					const ticket = JSON.parse(await readFile(path, "utf8")) as {
						expiresAt?: unknown;
					};
					if (typeof ticket.expiresAt === "number" && ticket.expiresAt > now)
						return;
				} catch {
					// Invalid managed tickets cannot be used and are safe to prune.
				}
				await rm(path, { force: true });
			}),
	);
};

export const ensureCloudSshKeypair = async (): Promise<string> => {
	await mkdir(sshRoot(), { recursive: true, mode: 0o700 });
	const key = keyPath();
	if (!existsSync(key)) {
		await execFileAsync("ssh-keygen", [
			"-q",
			"-t",
			"ed25519",
			"-N",
			"",
			"-C",
			"zuse-desktop",
			"-f",
			key,
		]);
	}
	return (await readFile(`${key}.pub`, "utf8")).trim();
};

export const managedSshConfig = (bridgeCommand: string): string =>
	[
		"# Managed by Zuse. Do not edit — this file is regenerated on demand.",
		"Host zuse-*",
		"\tUser zuse",
		`\tIdentityFile ${keyPath()}`,
		"\tIdentitiesOnly yes",
		"\tConnectTimeout 15",
		"\tStrictHostKeyChecking accept-new",
		`\tUserKnownHostsFile ${join(sshRoot(), "known_hosts")}`,
		`\tProxyCommand ${bridgeCommand} %n`,
		"",
	].join("\n");

/** Idempotently include the managed config from the user's ~/.ssh/config. */
export const withUserConfigInclude = (
	existing: string,
	includedPath: string,
): string | null =>
	existing.includes(includedPath)
		? null
		: `${INCLUDE_MARKER}\nInclude ${includedPath}\n\n${existing}`;

const ensureUserConfigInclude = async (): Promise<void> => {
	const userSshDir = join(homedir(), ".ssh");
	await mkdir(userSshDir, { recursive: true, mode: 0o700 });
	const configPath = join(userSshDir, "config");
	const existing = existsSync(configPath)
		? await readFile(configPath, "utf8")
		: "";
	const updated = withUserConfigInclude(existing, cloudSshConfigPath());
	if (updated !== null)
		await atomicWritePrivateFile(configPath, updated, 0o600);
};

/**
 * Ensure key material and ssh config exist, then stage the workspace ticket
 * for the ProxyCommand bridge. Returns everything the UI needs to launch
 * editors or copy the ssh command.
 */
export const prepareCloudSshAccess = async (
	access: CloudWorkspaceSshAccess,
	options: {
		readonly isPackaged?: boolean;
		readonly runtime?: CloudSshBridgeRuntime;
		readonly bridgeSourcePath?: string;
	} = {},
): Promise<CloudSshPrepared> => {
	if (!/^[A-Za-z0-9_-]+$/u.test(access.workspaceId))
		throw new Error("Invalid cloud workspace identifier");
	if (infrastructureSetup === null) {
		const setup = (async () => {
			const publicKey = await ensureCloudSshKeypair();
			const runtime =
				options.runtime ??
				(await resolveCloudSshBridgeRuntime(options.isPackaged ?? false));
			const bridgeSource = await readFile(
				options.bridgeSourcePath ?? resolveBridgeScript(),
			);
			await atomicWritePrivateFile(installedBridgePath(), bridgeSource, 0o700);
			await atomicWritePrivateFile(
				bridgeLauncherPath(),
				cloudSshBridgeLauncher(runtime, installedBridgePath()),
				0o700,
			);
			await atomicWritePrivateFile(
				cloudSshConfigPath(),
				managedSshConfig(shellQuote(bridgeLauncherPath())),
				0o600,
			);
			await ensureUserConfigInclude();
			await mkdir(ticketsDir(), { recursive: true, mode: 0o700 });
			await pruneExpiredCloudSshTickets();
			return publicKey;
		})().catch((cause) => {
			infrastructureSetup = null;
			throw cause;
		});
		infrastructureSetup = setup;
	}
	const publicKey = await infrastructureSetup;
	await atomicWritePrivateFile(
		join(ticketsDir(), `${access.workspaceId}.json`),
		JSON.stringify({
			wsUrl: access.wsUrl,
			ticket: access.ticket,
			expiresAt: access.expiresAt,
		}),
		0o600,
	);
	const hostAlias = cloudSshHostAlias(access.workspaceId);
	return {
		hostAlias,
		sshCommand: `ssh ${hostAlias}`,
		publicKey,
		remotePath: access.workspacePath,
	};
};

export type SshTargetLaunch =
	| { readonly kind: "uri"; readonly uri: string }
	| { readonly kind: "terminal"; readonly command: string };

/** How to launch each editor/terminal against a `zuse-*` ssh host alias. */
export const sshTargetLaunch = (
	target: string,
	hostAlias: string,
	remotePath: string,
): SshTargetLaunch | null => {
	switch (target) {
		case "cursor":
			return {
				kind: "uri",
				uri: `cursor://vscode-remote/ssh-remote+${hostAlias}${remotePath}`,
			};
		case "zed":
			return {
				kind: "uri",
				uri: `zed://ssh/zuse@${hostAlias}${remotePath}`,
			};
		case "terminal":
			return { kind: "terminal", command: `ssh ${hostAlias}` };
		default:
			return null;
	}
};
