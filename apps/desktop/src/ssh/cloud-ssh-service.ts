import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
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
const managedConfigPath = (): string => join(sshRoot(), "config");
const ticketsDir = (): string => join(sshRoot(), "tickets");

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
	const updated = withUserConfigInclude(existing, managedConfigPath());
	if (updated !== null) await writeFile(configPath, updated, { mode: 0o600 });
};

/**
 * Ensure key material and ssh config exist, then stage the workspace ticket
 * for the ProxyCommand bridge. Returns everything the UI needs to launch
 * editors or copy the ssh command.
 */
export const prepareCloudSshAccess = async (
	access: CloudWorkspaceSshAccess,
): Promise<CloudSshPrepared> => {
	const publicKey = await ensureCloudSshKeypair();
	const bridgeCommand = `env ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${resolveBridgeScript()}"`;
	await writeFile(managedConfigPath(), managedSshConfig(bridgeCommand), {
		mode: 0o600,
	});
	await ensureUserConfigInclude();
	await mkdir(ticketsDir(), { recursive: true, mode: 0o700 });
	await writeFile(
		join(ticketsDir(), `${access.workspaceId}.json`),
		JSON.stringify({
			wsUrl: access.wsUrl,
			ticket: access.ticket,
			expiresAt: access.expiresAt,
		}),
		{ mode: 0o600 },
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
