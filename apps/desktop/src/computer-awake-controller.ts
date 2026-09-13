import { spawn as nodeSpawn } from "node:child_process";

import type { ComputerAwakeMode, ComputerAwakeStatus } from "@zuse/contracts";

export const CAFFEINATE_RETRY_BASE_MS = 1_000;
export const CAFFEINATE_RETRY_MAX_MS = 30_000;

type Logger = Pick<Console, "debug" | "warn">;

export interface PowerSaveBlockerLike {
	readonly start: (type: "prevent-app-suspension") => number;
	readonly stop: (id: number) => boolean | undefined;
	readonly isStarted: (id: number) => boolean;
}

export interface PowerResumeSource {
	readonly on: (event: "resume", listener: () => void) => void;
	readonly off: (event: "resume", listener: () => void) => void;
}

interface CaffeinateProcess {
	readonly kill: () => boolean;
	on(event: "error", listener: (error: Error) => void): void;
	on(
		event: "exit",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): void;
	off(event: "error", listener: (error: Error) => void): void;
	off(
		event: "exit",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): void;
}

type SpawnCaffeinate = (
	command: string,
	args: ReadonlyArray<string>,
	options: { readonly stdio: "ignore"; readonly windowsHide: true },
) => CaffeinateProcess;

export interface ComputerAwakeControllerOptions {
	readonly blocker: PowerSaveBlockerLike;
	readonly initialMode?: ComputerAwakeMode;
	readonly logger?: Logger;
	readonly platform?: NodeJS.Platform;
	readonly powerMonitor?: PowerResumeSource | null;
	readonly spawn?: SpawnCaffeinate;
	readonly setTimeout?: typeof globalThis.setTimeout;
	readonly clearTimeout?: typeof globalThis.clearTimeout;
}

const count = (value: number): number =>
	Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

export class ComputerAwakeController {
	private mode: ComputerAwakeMode;
	private activeAgents = 0;
	private remoteClients = 0;
	private blockerId: number | null = null;
	private caffeinate: CaffeinateProcess | null = null;
	private caffeinateCleanup: (() => void) | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private electronWarning: string | null = null;
	private caffeinateWarning: string | null = null;
	private caffeinateRetryAttempt = 0;
	private disposed = false;
	private readonly listeners = new Set<(status: ComputerAwakeStatus) => void>();
	private readonly logger: Logger;
	private readonly platform: NodeJS.Platform;
	private readonly spawn: SpawnCaffeinate;
	private readonly setTimer: typeof globalThis.setTimeout;
	private readonly clearTimer: typeof globalThis.clearTimeout;
	private readonly removeResumeListener: (() => void) | null;

	constructor(private readonly options: ComputerAwakeControllerOptions) {
		this.mode = options.initialMode ?? "auto";
		this.logger = options.logger ?? console;
		this.platform = options.platform ?? process.platform;
		this.spawn = options.spawn ?? (nodeSpawn as unknown as SpawnCaffeinate);
		this.setTimer = options.setTimeout ?? globalThis.setTimeout;
		this.clearTimer = options.clearTimeout ?? globalThis.clearTimeout;
		const source = options.powerMonitor ?? null;
		if (source === null) {
			this.removeResumeListener = null;
		} else {
			const resume = () => this.refresh("resume");
			source.on("resume", resume);
			this.removeResumeListener = () => source.off("resume", resume);
		}
		this.refresh("initialize");
	}

	getStatus(): ComputerAwakeStatus {
		const supported = this.platform === "darwin";
		const electronBlockerActive = this.isElectronBlockerActive();
		const caffeinateActive = this.caffeinate !== null;
		return {
			supported,
			mode: this.mode,
			active:
				supported &&
				this.shouldActivate() &&
				(electronBlockerActive || caffeinateActive),
			activeAgents: this.activeAgents,
			remoteClients: this.remoteClients,
			electronBlockerActive,
			caffeinateActive,
			warning:
				supported && this.shouldActivate()
					? [this.electronWarning, this.caffeinateWarning]
							.filter((item): item is string => item !== null)
							.join(" ") || null
					: null,
		};
	}

	setMode(mode: ComputerAwakeMode): void {
		if (this.mode === mode) return;
		this.mode = mode;
		this.refresh("mode-change");
	}

	setActiveAgents(value: number): void {
		const next = count(value);
		if (next === this.activeAgents) return;
		this.activeAgents = next;
		this.refresh("agent-count");
	}

	setRemoteClients(value: number): void {
		const next = count(value);
		if (next === this.remoteClients) return;
		this.remoteClients = next;
		this.refresh("remote-count");
	}

	subscribe(listener: (status: ComputerAwakeStatus) => void): () => void {
		this.listeners.add(listener);
		listener(this.getStatus());
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.removeResumeListener?.();
		this.clearRetry();
		this.stopCaffeinate();
		this.stopElectronBlocker();
		this.listeners.clear();
	}

	private shouldActivate(): boolean {
		return (
			this.mode === "always" ||
			(this.mode === "auto" &&
				(this.activeAgents > 0 || this.remoteClients > 0))
		);
	}

	private refresh(reason: string): void {
		if (this.disposed) return;
		if (this.platform !== "darwin" || !this.shouldActivate()) {
			this.electronWarning = null;
			this.caffeinateWarning = null;
			this.clearRetry();
			this.stopCaffeinate();
			this.stopElectronBlocker();
			this.publish();
			return;
		}
		this.startElectronBlocker(reason);
		this.startCaffeinate(reason);
		this.publish();
	}

	private isElectronBlockerActive(): boolean {
		if (this.blockerId === null) return false;
		try {
			if (this.options.blocker.isStarted(this.blockerId)) {
				this.electronWarning = null;
				return true;
			}
			this.blockerId = null;
		} catch (cause) {
			this.electronWarning =
				"Electron could not verify the system-awake assertion.";
			this.logger.warn("[computer-awake] failed to inspect Electron blocker", {
				cause,
			});
			return true;
		}
		return false;
	}

	private startElectronBlocker(reason: string): void {
		if (this.isElectronBlockerActive()) return;
		try {
			this.blockerId = this.options.blocker.start("prevent-app-suspension");
			if (!this.isElectronBlockerActive()) {
				this.electronWarning =
					"Electron could not hold the system-awake assertion.";
			} else {
				this.electronWarning = null;
			}
		} catch (cause) {
			this.blockerId = null;
			this.electronWarning =
				"Electron could not hold the system-awake assertion.";
			this.logger.warn("[computer-awake] failed to start Electron blocker", {
				reason,
				cause,
			});
		}
	}

	private stopElectronBlocker(): void {
		if (this.blockerId === null) return;
		const id = this.blockerId;
		try {
			this.options.blocker.stop(id);
		} catch (cause) {
			this.logger.warn("[computer-awake] failed to stop Electron blocker", {
				cause,
			});
		}
		if (!this.isElectronBlockerActive()) this.blockerId = null;
	}

	private startCaffeinate(reason: string): void {
		if (this.caffeinate !== null || this.retryTimer !== null) return;
		let child: CaffeinateProcess;
		try {
			child = this.spawn("/usr/bin/caffeinate", ["-i", "-s"], {
				stdio: "ignore",
				windowsHide: true,
			});
		} catch (cause) {
			this.handleCaffeinateFailure(reason, cause);
			return;
		}
		this.caffeinate = child;
		let finished = false;
		const fail = (detail: unknown) => {
			if (finished || this.caffeinate !== child) return;
			finished = true;
			this.detachCaffeinate();
			this.caffeinate = null;
			this.handleCaffeinateFailure(reason, detail);
		};
		const onError = (error: Error) => fail(error);
		const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
			fail({ code, signal });
		child.on("error", onError);
		child.on("exit", onExit);
		this.caffeinateCleanup = () => {
			child.off("error", onError);
			child.off("exit", onExit);
		};
		this.caffeinateWarning = null;
	}

	private handleCaffeinateFailure(reason: string, cause: unknown): void {
		this.caffeinateWarning =
			"Closed-lid sleep prevention is unavailable; idle-sleep prevention may still be active.";
		this.logger.warn("[computer-awake] caffeinate assertion failed", {
			reason,
			cause,
		});
		this.scheduleRetry();
		this.publish();
	}

	private scheduleRetry(): void {
		if (this.retryTimer !== null || !this.shouldActivate() || this.disposed)
			return;
		const delay = Math.min(
			CAFFEINATE_RETRY_MAX_MS,
			CAFFEINATE_RETRY_BASE_MS * 2 ** this.caffeinateRetryAttempt,
		);
		this.caffeinateRetryAttempt += 1;
		this.retryTimer = this.setTimer(() => {
			this.retryTimer = null;
			this.refresh("caffeinate-retry");
		}, delay);
		this.retryTimer.unref?.();
	}

	private clearRetry(): void {
		if (this.retryTimer !== null) {
			this.clearTimer(this.retryTimer);
			this.retryTimer = null;
		}
		this.caffeinateRetryAttempt = 0;
	}

	private detachCaffeinate(): void {
		this.caffeinateCleanup?.();
		this.caffeinateCleanup = null;
	}

	private stopCaffeinate(): void {
		if (this.caffeinate === null) return;
		const child = this.caffeinate;
		this.caffeinate = null;
		this.detachCaffeinate();
		try {
			child.kill();
		} catch (cause) {
			this.logger.debug("[computer-awake] caffeinate was already stopped", {
				cause,
			});
		}
	}

	private publish(): void {
		const status = this.getStatus();
		for (const listener of this.listeners) listener(status);
	}
}
