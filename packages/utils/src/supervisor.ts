export type SupervisorStatus =
	| "offline"
	| "connecting"
	| "connected"
	| "reconnecting";

export type SupervisorSnapshot = {
	readonly status: SupervisorStatus;
	readonly attempt: number;
	readonly generation: number;
};

const STABLE_RESET_MS = 30_000;
const MAX_BACKOFF_MS = 16_000;

export class ConnectionSupervisorState {
	private connectedAt: number | null = null;
	private state: SupervisorSnapshot = {
		status: "connecting",
		attempt: 0,
		generation: 0,
	};

	snapshot(): SupervisorSnapshot {
		return this.state;
	}

	connected(now: number): void {
		this.connectedAt = now;
		this.state = {
			status: "connected",
			attempt: this.state.attempt,
			generation: this.state.generation + 1,
		};
	}

	failed(now: number): number {
		const stable =
			this.connectedAt !== null && now - this.connectedAt >= STABLE_RESET_MS;
		const attempt = stable ? 0 : this.state.attempt;
		const delay = Math.min(1_000 * 2 ** attempt, MAX_BACKOFF_MS);
		this.connectedAt = null;
		this.state = {
			...this.state,
			status: "reconnecting",
			attempt: attempt + 1,
		};
		return delay;
	}

	networkChanged(online: boolean): boolean {
		this.connectedAt = null;
		this.state = {
			...this.state,
			status: online ? "reconnecting" : "offline",
		};
		return online;
	}

	wake(): void {
		if (this.state.status === "offline") return;
		this.state = { ...this.state, status: "reconnecting" };
	}
}
