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

import { cloudSshConfigPath } from "../ssh/cloud-ssh-service.ts";

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
const TRANSFER_INACTIVITY_TIMEOUT_MS = 30_000;
const TRANSFER_TERMINATE_GRACE_MS = 2_000;
const GENERATED_SYNC_EXCLUDES = [
	"node_modules",
	".cache",
	".turbo",
	".next/cache",
	"__pycache__",
	".pytest_cache",
	".zuse-rsync-partial",
] as const;

export type CloudSyncState = "idle" | "syncing" | "in-sync" | "error";

export interface CloudSyncStatus {
	readonly workspaceId: string;
	readonly enabled: boolean;
	readonly state: CloudSyncState;
	readonly localPath: string | null;
	readonly lastSyncedAt: number | null;
	readonly error: string | null;
	/** Access is near expiry or the SSH transport failed and must be refreshed. */
	readonly accessRefreshRequired: boolean;
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
	"--delay-updates",
	"--delete-delay",
	"--partial-dir=.zuse-rsync-partial",
	"--timeout=30",
	"--exclude=.git/",
	`--exclude=${SYNC_MARKER_FILE}`,
	...GENERATED_SYNC_EXCLUDES.map((path) => `--exclude=${path}/`),
	...(input.gitignoreFilter ? ["--filter=:- .gitignore"] : []),
	...(!input.gitignoreFilter
		? ["--rsync-path=rsync --filter=:-_.gitignore"]
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
	accessRefreshRequired: boolean;
	running: boolean;
	rerunRequested: boolean;
	backoffMs: number;
	timer: NodeJS.Timeout | null;
	abortController: AbortController | null;
	completion: Promise<void> | null;
}

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
			signal?: AbortSignal,
		) => Promise<{ code: number; stderr: string }> = defaultRunRsync,
		private readonly runLegacySync: (
			input: CloudSyncConfigureInput,
			signal?: AbortSignal,
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
			accessRefreshRequired: entry?.accessRefreshRequired ?? false,
		};
	}

	async configure(input: CloudSyncConfigureInput): Promise<CloudSyncStatus> {
		const existing = this.entries.get(input.workspaceId);
		if (existing !== undefined) {
			this.entries.delete(input.workspaceId);
			this.cancelEntry(existing);
			await existing.completion;
		}
		if (!input.enabled) {
			const status = this.status(input.workspaceId);
			this.notify(status);
			return status;
		}
		const entry: SyncEntry = {
			config: input,
			state: existing?.state === "in-sync" ? "in-sync" : "idle",
			lastSyncedAt: existing?.lastSyncedAt ?? null,
			error: null,
			accessRefreshRequired: false,
			running: false,
			rerunRequested: false,
			backoffMs: ERROR_BACKOFF_MIN_MS,
			timer: null,
			abortController: null,
			completion: null,
		};
		this.entries.set(input.workspaceId, entry);
		const guard = await this.guardLocalPath(input);
		if (guard !== null) {
			entry.state = "error";
			entry.error = guard;
			this.publish(input.workspaceId);
			return this.status(input.workspaceId);
		}
		this.launchSync(input.workspaceId);
		return this.status(input.workspaceId);
	}

	/** Debounced change-driven sync request (from fs.watchTree frames). */
	requestSync(workspaceId: string): void {
		const entry = this.entries.get(workspaceId);
		if (entry === undefined || !entry.config.enabled) return;
		this.schedule(workspaceId, entry, DEBOUNCE_MS);
	}

	async dispose(): Promise<void> {
		const entries = [...this.entries.values()];
		for (const entry of entries) this.cancelEntry(entry);
		this.entries.clear();
		await Promise.all(entries.map((entry) => entry.completion));
	}

	private cancelEntry(entry: SyncEntry): void {
		this.clearTimers(entry);
		entry.abortController?.abort();
		entry.abortController = null;
	}

	private clearTimers(entry: SyncEntry): void {
		if (entry.timer !== null) clearTimeout(entry.timer);
		entry.timer = null;
	}

	private schedule(workspaceId: string, entry: SyncEntry, delay: number): void {
		this.clearTimers(entry);
		entry.timer = setTimeout(() => {
			entry.timer = null;
			this.launchSync(workspaceId);
		}, delay);
		entry.timer.unref?.();
	}

	private launchSync(workspaceId: string): void {
		const entry = this.entries.get(workspaceId);
		if (entry === undefined || !entry.config.enabled) return;
		if (entry.running) {
			entry.rerunRequested = true;
			return;
		}
		const operation = this.sync(workspaceId).finally(() => {
			if (entry.completion === operation) entry.completion = null;
		});
		entry.completion = operation;
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
		entry.running = true;
		entry.state = "syncing";
		const abortController = new AbortController();
		entry.abortController = abortController;
		entry.accessRefreshRequired = !(await ticketFresh(workspaceId));
		if (
			abortController.signal.aborted ||
			this.entries.get(workspaceId) !== entry
		)
			return;
		this.publish(workspaceId);
		let nextDelay = PERIODIC_FALLBACK_MS;
		try {
			const args = rsyncArgs({
				hostAlias: entry.config.hostAlias,
				remotePath: entry.config.remotePath,
				localPath: entry.config.localPath,
				sshConfigPath: cloudSshConfigPath(),
				gitignoreFilter: await this.resolveGitignoreFilter(),
			});
			if (abortController.signal.aborted) return;
			let result = await this.runRsync(args, abortController.signal);
			if (
				!abortController.signal.aborted &&
				result.code !== 0 &&
				remoteRsyncMissing(result.stderr)
			)
				result = await this.runLegacySync(entry.config, abortController.signal);
			if (this.entries.get(workspaceId) !== entry) return;
			if (result.code === 0) {
				entry.state = "in-sync";
				entry.error = null;
				entry.lastSyncedAt = Date.now();
				entry.backoffMs = ERROR_BACKOFF_MIN_MS;
				entry.accessRefreshRequired = false;
			} else {
				entry.state = "error";
				entry.error = result.stderr.trim().split("\n").slice(-3).join("\n");
				if (sshTransportFailed(result.stderr))
					entry.accessRefreshRequired = true;
				nextDelay = entry.backoffMs;
				entry.backoffMs = Math.min(entry.backoffMs * 2, ERROR_BACKOFF_MAX_MS);
			}
		} catch (cause) {
			if (abortController.signal.aborted) return;
			entry.state = "error";
			entry.error = cause instanceof Error ? cause.message : String(cause);
			nextDelay = entry.backoffMs;
			entry.backoffMs = Math.min(entry.backoffMs * 2, ERROR_BACKOFF_MAX_MS);
		} finally {
			if (entry.abortController === abortController)
				entry.abortController = null;
			entry.running = false;
			if (this.entries.get(workspaceId) === entry) {
				this.publish(workspaceId);
				if (entry.rerunRequested) {
					entry.rerunRequested = false;
					this.launchSync(workspaceId);
				} else if (entry.timer === null) {
					this.schedule(workspaceId, entry, nextDelay);
				}
			}
		}
	}
}

const defaultRunRsync = (
	args: ReadonlyArray<string>,
	signal?: AbortSignal,
): Promise<{ code: number; stderr: string }> =>
	new Promise((resolve, reject) => {
		const child = spawn("rsync", [...args], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		let settled = false;
		let forcedTermination: NodeJS.Timeout | null = null;
		const finish = (result: { code: number; stderr: string }): void => {
			if (settled) return;
			settled = true;
			if (forcedTermination !== null) clearTimeout(forcedTermination);
			signal?.removeEventListener("abort", abort);
			resolve(result);
		};
		const fail = (cause: Error): void => {
			if (settled) return;
			settled = true;
			if (forcedTermination !== null) clearTimeout(forcedTermination);
			signal?.removeEventListener("abort", abort);
			reject(cause);
		};
		const abort = (): void => {
			child.kill("SIGTERM");
			forcedTermination = setTimeout(
				() => child.kill("SIGKILL"),
				TRANSFER_TERMINATE_GRACE_MS,
			);
			forcedTermination.unref?.();
		};
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString()}`.slice(-4_096);
		});
		child.once("error", (cause) => {
			if (signal?.aborted) finish({ code: 1, stderr: "Sync cancelled." });
			else fail(cause);
		});
		child.once("close", (code) =>
			finish({
				code: signal?.aborted ? 1 : (code ?? 1),
				stderr: signal?.aborted ? "Sync cancelled." : stderr,
			}),
		);
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});

/** Compatibility path for workspaces created before rsync entered the image. */
const defaultRunLegacySync = async (
	input: CloudSyncConfigureInput,
	signal?: AbortSignal,
): Promise<{ code: number; stderr: string }> => {
	const staging = await mkdtemp(`${input.localPath}.incoming-`);
	try {
		const result = await streamTarArchive(input, staging, signal);
		if (result.code !== 0) return result;
		if (signal?.aborted) return { code: 1, stderr: "Sync cancelled." };
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
	signal?: AbortSignal,
): Promise<{ code: number; stderr: string }> =>
	new Promise((resolve) => {
		const remote = spawn(
			"ssh",
			[
				"-F",
				cloudSshConfigPath(),
				input.hostAlias,
				"tar",
				"-C",
				input.remotePath,
				"--exclude=.git",
				"--exclude-vcs-ignores",
				`--exclude=${SYNC_MARKER_FILE}`,
				...GENERATED_SYNC_EXCLUDES.map((path) => `--exclude=${path}`),
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
		let settled = false;
		let inactivityTimer: NodeJS.Timeout;
		const terminate = (reason?: string): void => {
			if (reason !== undefined) stderr = reason;
			remote.kill("SIGTERM");
			local.kill("SIGTERM");
			const forced = setTimeout(() => {
				remote.kill("SIGKILL");
				local.kill("SIGKILL");
			}, TRANSFER_TERMINATE_GRACE_MS);
			forced.unref?.();
		};
		const abort = (): void => terminate();
		const resetInactivity = (): void => {
			clearTimeout(inactivityTimer);
			inactivityTimer = setTimeout(
				() =>
					terminate(
						"Sync timed out after 30 seconds without transferred data.",
					),
				TRANSFER_INACTIVITY_TIMEOUT_MS,
			);
			inactivityTimer.unref?.();
		};
		const appendError = (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString()}`.slice(-4_096);
			resetInactivity();
		};
		remote.stderr.on("data", appendError);
		local.stderr.on("data", appendError);
		remote.stdout.on("data", resetInactivity);
		remote.stdout.pipe(local.stdin);
		let remoteCode: number | null = null;
		let localCode: number | null = null;
		const finish = () => {
			if (settled || remoteCode === null || localCode === null) return;
			settled = true;
			clearTimeout(inactivityTimer);
			signal?.removeEventListener("abort", abort);
			resolve({
				code: !signal?.aborted && remoteCode === 0 && localCode === 0 ? 0 : 1,
				stderr: signal?.aborted ? "Sync cancelled." : stderr,
			});
		};
		remote.once("error", (cause) => {
			terminate(cause.message);
		});
		local.once("error", (cause) => {
			terminate(cause.message);
		});
		remote.once("close", (code) => {
			remoteCode = code ?? 1;
			finish();
		});
		local.once("close", (code) => {
			localCode = code ?? 1;
			finish();
		});
		resetInactivity();
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});

export const sshTransportFailed = (stderr: string): boolean =>
	/(?:zuse ssh bridge:|permission denied|connection (?:unexpectedly )?(?:closed|reset|timed out)|kex_exchange_identification|broken pipe|no route to host|could not resolve hostname)/iu.test(
		stderr,
	);
