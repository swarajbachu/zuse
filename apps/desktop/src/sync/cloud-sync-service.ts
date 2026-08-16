import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * One-way cloud→local file sync for cloud workspaces.
 *
 * Each enabled workspace mirrors `/home/zuse/workspace` from the sandbox into
 * a local directory with rsync over the Feature-B SSH channel (the `zuse-*`
 * host alias whose ProxyCommand bridges a WebSocket to `sshd -i`). The local
 * directory is a mirror: local edits are overwritten on the next sync.
 * Non-empty directories are refused unless they carry the `.zuse-sync.json`
 * marker from a previous sync, so an enable can never clobber unrelated data.
 */

const execFileAsync = promisify(execFile);

export const SYNC_MARKER_FILE = ".zuse-sync.json";
const DEBOUNCE_MS = 1_500;
const PERIODIC_FALLBACK_MS = 60_000;
const ERROR_BACKOFF_MIN_MS = 5_000;
const ERROR_BACKOFF_MAX_MS = 60_000;
const TICKET_STALE_MARGIN_MS = 10 * 60_000;

export type CloudSyncState = "idle" | "syncing" | "in-sync" | "error";

export interface CloudSyncStatus {
	readonly workspaceId: string;
	readonly enabled: boolean;
	readonly state: CloudSyncState;
	readonly localPath: string | null;
	readonly lastSyncedAt: number | null;
	readonly error: string | null;
	/** The SSH ticket is missing or near expiry; the renderer should refresh it. */
	readonly ticketStale: boolean;
}

export interface CloudSyncConfigureInput {
	readonly workspaceId: string;
	readonly enabled: boolean;
	readonly localPath: string;
	readonly hostAlias: string;
	readonly remotePath: string;
}

/** openrsync (macOS) rejects `--filter`; GNU rsync supports it. */
export const supportsGitignoreFilter = (versionOutput: string): boolean =>
	!versionOutput.includes("openrsync") && versionOutput.includes("version 3");

export const remoteRsyncMissing = (stderr: string): boolean =>
	/(?:rsync: )?command not found/u.test(stderr);

export const rsyncArgs = (input: {
	readonly hostAlias: string;
	readonly remotePath: string;
	readonly localPath: string;
	readonly sshConfigPath: string;
	readonly gitignoreFilter: boolean;
}): ReadonlyArray<string> => [
	"-az",
	"--delete",
	"--exclude=.git/",
	`--exclude=${SYNC_MARKER_FILE}`,
	...(input.gitignoreFilter ? ["--filter=:- .gitignore"] : []),
	...(!input.gitignoreFilter
		? ["--rsync-path=rsync --filter=':- .gitignore'"]
		: []),
	"-e",
	`ssh -F "${input.sshConfigPath}"`,
	`${input.hostAlias}:${input.remotePath.replace(/\/$/u, "")}/`,
	`${input.localPath.replace(/\/$/u, "")}/`,
];

interface SyncEntry {
	config: CloudSyncConfigureInput;
	state: CloudSyncState;
	lastSyncedAt: number | null;
	error: string | null;
	ticketStale: boolean;
	running: boolean;
	rerunRequested: boolean;
	backoffMs: number;
	timer: NodeJS.Timeout | null;
}

const sshConfigPath = (): string => join(homedir(), ".zuse", "ssh", "config");
const ticketPath = (workspaceId: string): string =>
	join(homedir(), ".zuse", "ssh", "tickets", `${workspaceId}.json`);

export const cloudSyncDefaultPath = (
	home: string,
	repository: unknown,
	branch: unknown,
): string | null => {
	if (typeof repository !== "string" || typeof branch !== "string") return null;
	const repositoryName = repository
		.split(/[\\/]/u)
		.at(-1)
		?.replace(/\.git$/u, "");
	if (repositoryName === undefined) return null;
	const segments = [repositoryName, ...branch.split("/")];
	return segments.some(
		(segment) => !/^(?!\.{1,2}$)[A-Za-z0-9._-]+$/u.test(segment),
	)
		? null
		: join(home, ".zuse", "cloud", ...segments);
};

const ticketFresh = async (workspaceId: string): Promise<boolean> => {
	try {
		const parsed = JSON.parse(
			await readFile(ticketPath(workspaceId), "utf8"),
		) as { expiresAt?: unknown };
		return (
			typeof parsed.expiresAt === "number" &&
			parsed.expiresAt > Date.now() + TICKET_STALE_MARGIN_MS
		);
	} catch {
		return false;
	}
};

export class CloudSyncManager {
	private readonly entries = new Map<string, SyncEntry>();
	private gitignoreFilter: boolean | null = null;

	constructor(
		private readonly notify: (status: CloudSyncStatus) => void,
		private readonly runRsync: (
			args: ReadonlyArray<string>,
		) => Promise<{ code: number; stderr: string }> = defaultRunRsync,
		private readonly runLegacySync: (
			input: CloudSyncConfigureInput,
		) => Promise<{ code: number; stderr: string }> = defaultRunLegacySync,
	) {}

	status(workspaceId: string): CloudSyncStatus {
		const entry = this.entries.get(workspaceId);
		return {
			workspaceId,
			enabled: entry?.config.enabled ?? false,
			state: entry?.state ?? "idle",
			localPath: entry?.config.localPath ?? null,
			lastSyncedAt: entry?.lastSyncedAt ?? null,
			error: entry?.error ?? null,
			ticketStale: entry?.ticketStale ?? false,
		};
	}

	async configure(input: CloudSyncConfigureInput): Promise<CloudSyncStatus> {
		const existing = this.entries.get(input.workspaceId);
		if (existing !== undefined) this.clearTimers(existing);
		if (!input.enabled) {
			this.entries.delete(input.workspaceId);
			const status = this.status(input.workspaceId);
			this.notify(status);
			return status;
		}
		const entry: SyncEntry = {
			config: input,
			state: existing?.state === "in-sync" ? "in-sync" : "idle",
			lastSyncedAt: existing?.lastSyncedAt ?? null,
			error: null,
			ticketStale: false,
			running: false,
			rerunRequested: false,
			backoffMs: ERROR_BACKOFF_MIN_MS,
			timer: null,
		};
		this.entries.set(input.workspaceId, entry);
		const guard = await this.guardLocalPath(input);
		if (guard !== null) {
			entry.state = "error";
			entry.error = guard;
			this.publish(input.workspaceId);
			return this.status(input.workspaceId);
		}
		void this.sync(input.workspaceId);
		return this.status(input.workspaceId);
	}

	/** Debounced change-driven sync request (from fs.watchTree frames). */
	requestSync(workspaceId: string): void {
		const entry = this.entries.get(workspaceId);
		if (entry === undefined || !entry.config.enabled) return;
		this.schedule(workspaceId, entry, DEBOUNCE_MS);
	}

	dispose(): void {
		for (const entry of this.entries.values()) this.clearTimers(entry);
		this.entries.clear();
	}

	private clearTimers(entry: SyncEntry): void {
		if (entry.timer !== null) clearTimeout(entry.timer);
		entry.timer = null;
	}

	private schedule(workspaceId: string, entry: SyncEntry, delay: number): void {
		this.clearTimers(entry);
		entry.timer = setTimeout(() => {
			entry.timer = null;
			void this.sync(workspaceId);
		}, delay);
		entry.timer.unref?.();
	}

	private async guardLocalPath(
		input: CloudSyncConfigureInput,
	): Promise<string | null> {
		try {
			await mkdir(input.localPath, { recursive: true });
			const contents = await readdir(input.localPath);
			const marker = join(input.localPath, SYNC_MARKER_FILE);
			if (contents.length > 0 && !existsSync(marker)) {
				return "The chosen folder is not empty. Pick an empty folder or a previous sync target.";
			}
			await writeFile(
				marker,
				`${JSON.stringify({ workspaceId: input.workspaceId })}\n`,
			);
			return null;
		} catch (cause) {
			return cause instanceof Error ? cause.message : String(cause);
		}
	}

	private publish(workspaceId: string): void {
		this.notify(this.status(workspaceId));
	}

	private async resolveGitignoreFilter(): Promise<boolean> {
		if (this.gitignoreFilter !== null) return this.gitignoreFilter;
		try {
			const { stdout } = await execFileAsync("rsync", ["--version"]);
			this.gitignoreFilter = supportsGitignoreFilter(stdout);
		} catch {
			this.gitignoreFilter = false;
		}
		return this.gitignoreFilter;
	}

	private async sync(workspaceId: string): Promise<void> {
		const entry = this.entries.get(workspaceId);
		if (entry === undefined || !entry.config.enabled) return;
		if (entry.running) {
			entry.rerunRequested = true;
			return;
		}
		entry.running = true;
		entry.state = "syncing";
		entry.ticketStale = !(await ticketFresh(workspaceId));
		this.publish(workspaceId);
		let nextDelay = PERIODIC_FALLBACK_MS;
		try {
			const args = rsyncArgs({
				hostAlias: entry.config.hostAlias,
				remotePath: entry.config.remotePath,
				localPath: entry.config.localPath,
				sshConfigPath: sshConfigPath(),
				gitignoreFilter: await this.resolveGitignoreFilter(),
			});
			let result = await this.runRsync(args);
			if (result.code !== 0 && remoteRsyncMissing(result.stderr))
				result = await this.runLegacySync(entry.config);
			if (this.entries.get(workspaceId) !== entry) return;
			if (result.code === 0) {
				entry.state = "in-sync";
				entry.error = null;
				entry.lastSyncedAt = Date.now();
				entry.backoffMs = ERROR_BACKOFF_MIN_MS;
			} else {
				entry.state = "error";
				entry.error = result.stderr.trim().split("\n").slice(-3).join("\n");
				nextDelay = entry.backoffMs;
				entry.backoffMs = Math.min(entry.backoffMs * 2, ERROR_BACKOFF_MAX_MS);
			}
		} catch (cause) {
			entry.state = "error";
			entry.error = cause instanceof Error ? cause.message : String(cause);
			nextDelay = entry.backoffMs;
			entry.backoffMs = Math.min(entry.backoffMs * 2, ERROR_BACKOFF_MAX_MS);
		} finally {
			entry.running = false;
			if (this.entries.get(workspaceId) === entry) {
				this.publish(workspaceId);
				if (entry.rerunRequested) {
					entry.rerunRequested = false;
					void this.sync(workspaceId);
				} else this.schedule(workspaceId, entry, nextDelay);
			}
		}
	}
}

const defaultRunRsync = (
	args: ReadonlyArray<string>,
): Promise<{ code: number; stderr: string }> =>
	new Promise((resolve, reject) => {
		const child = spawn("rsync", [...args], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString()}`.slice(-4_096);
		});
		child.once("error", reject);
		child.once("close", (code) => resolve({ code: code ?? 1, stderr }));
	});

/** Compatibility path for workspaces created before rsync entered the image. */
const defaultRunLegacySync = async (
	input: CloudSyncConfigureInput,
): Promise<{ code: number; stderr: string }> => {
	const staging = await mkdtemp(`${input.localPath}.incoming-`);
	try {
		const result = await streamTarArchive(input, staging);
		if (result.code !== 0) return result;
		for (const name of await readdir(input.localPath)) {
			if (name !== SYNC_MARKER_FILE)
				await rm(join(input.localPath, name), { recursive: true, force: true });
		}
		for (const name of await readdir(staging))
			await rename(join(staging, name), join(input.localPath, name));
		return result;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
};

const streamTarArchive = (
	input: CloudSyncConfigureInput,
	staging: string,
): Promise<{ code: number; stderr: string }> =>
	new Promise((resolve, reject) => {
		const remote = spawn(
			"ssh",
			[
				"-F",
				sshConfigPath(),
				input.hostAlias,
				"tar",
				"-C",
				input.remotePath,
				"--exclude=.git",
				"--exclude-vcs-ignores",
				`--exclude=${SYNC_MARKER_FILE}`,
				"-czf",
				"-",
				".",
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		const local = spawn("tar", ["-xzf", "-", "-C", staging], {
			stdio: ["pipe", "ignore", "pipe"],
		});
		let stderr = "";
		const appendError = (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString()}`.slice(-4_096);
		};
		remote.stderr.on("data", appendError);
		local.stderr.on("data", appendError);
		remote.stdout.pipe(local.stdin);
		let remoteCode: number | null = null;
		let localCode: number | null = null;
		const finish = () => {
			if (remoteCode === null || localCode === null) return;
			resolve({
				code: remoteCode === 0 && localCode === 0 ? 0 : 1,
				stderr,
			});
		};
		remote.once("error", reject);
		local.once("error", reject);
		remote.once("close", (code) => {
			remoteCode = code ?? 1;
			finish();
		});
		local.once("close", (code) => {
			localCode = code ?? 1;
			finish();
		});
	});
