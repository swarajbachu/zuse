export interface ActiveInterval {
	readonly activeSeconds: number;
	readonly endedAt: number;
}

export interface ActiveTimeOptions {
	readonly idleAfterMs?: number;
	readonly flushAfterMs?: number;
	readonly now?: () => number;
	readonly onInterval: (interval: ActiveInterval) => void;
}

/**
 * Counts foreground/focused time only while recent user interaction proves the
 * app is active. The first foreground minute counts as active after launch.
 */
export class ActiveTimeTracker {
	readonly #idleAfterMs: number;
	readonly #flushAfterMs: number;
	readonly #now: () => number;
	readonly #onInterval: (interval: ActiveInterval) => void;
	#foreground = false;
	#lastInteractionAt = 0;
	#lastTickAt = 0;
	#accumulatedMs = 0;

	constructor(options: ActiveTimeOptions) {
		this.#idleAfterMs = options.idleAfterMs ?? 60_000;
		this.#flushAfterMs = options.flushAfterMs ?? 300_000;
		this.#now = options.now ?? Date.now;
		this.#onInterval = options.onInterval;
	}

	foreground(): void {
		const now = this.#now();
		this.#foreground = true;
		this.#lastInteractionAt = now;
		this.#lastTickAt = now;
	}

	interact(): void {
		const now = this.#now();
		this.tick(now);
		this.#lastInteractionAt = now;
	}

	background(): void {
		const now = this.#now();
		this.tick(now);
		this.#foreground = false;
		this.flush(now);
	}

	tick(at: number = this.#now()): void {
		if (!this.#foreground) {
			this.#lastTickAt = at;
			return;
		}
		const eligibleUntil = Math.min(
			at,
			this.#lastInteractionAt + this.#idleAfterMs,
		);
		this.#accumulatedMs += Math.max(0, eligibleUntil - this.#lastTickAt);
		this.#lastTickAt = at;
		if (this.#accumulatedMs >= this.#flushAfterMs) this.flush(at);
	}

	flush(at: number = this.#now()): void {
		const activeSeconds = Math.floor(this.#accumulatedMs / 1_000);
		this.#accumulatedMs -= activeSeconds * 1_000;
		if (activeSeconds > 0) {
			this.#onInterval({ activeSeconds, endedAt: at });
		}
	}
}
