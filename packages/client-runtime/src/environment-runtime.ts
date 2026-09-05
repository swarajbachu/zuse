import type { EnvironmentId } from "@zuse/contracts";
import { Effect } from "effect";

import type { ConnectionPhase, ConnectionView } from "./resource-state";

export type ResourceActivation = "cache-only" | "sync" | "connect" | "wake";
type NetworkActivation = Exclude<ResourceActivation, "cache-only" | "sync">;

export type ResolvedEnvironment<Client> = Readonly<{
	client: Client;
	dispose: () => Promise<void>;
	/** Bind transport callbacks only after this session becomes the generation. */
	onActivated?: (generation: number) => void;
}>;

export type EnvironmentFault = Readonly<{
	phase: Extract<
		ConnectionPhase,
		"offline" | "blocked-auth" | "update-required" | "revoked" | "failed"
	>;
	message: string;
}>;

export interface EnvironmentResolver<Client> {
	readonly resolve: (
		environmentId: EnvironmentId,
		activation: NetworkActivation,
	) => Effect.Effect<ResolvedEnvironment<Client>, EnvironmentFault>;
}

export type EnvironmentRuntimeOptions = Readonly<{
	isOnline?: () => boolean;
	/**
	 * Whether this environment's transport crosses the network. Environments
	 * reached in-process ignore platform offline edges. Default: true.
	 */
	requiresNetwork?: (environmentId: EnvironmentId) => boolean;
	schedule?: (delayMs: number, task: () => void) => () => void;
	random?: () => number;
}>;

export type EnvironmentRuntimeLease<Client> = Readonly<{
	activate: (activation: ResourceActivation) => Promise<Client | null>;
	release: () => void;
}>;

const activationRank = (activation: ResourceActivation): number => {
	switch (activation) {
		case "cache-only":
			return 0;
		case "sync":
			return 1;
		case "connect":
			return 2;
		case "wake":
			return 3;
	}
};

const strongestActivation = (
	left: ResourceActivation,
	right: ResourceActivation,
): ResourceActivation =>
	activationRank(left) >= activationRank(right) ? left : right;

const failureMessage = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

export class EnvironmentRuntime<Client> {
	private static readonly RETRY_DELAYS_MS = [
		250, 500, 1_000, 2_000, 5_000, 10_000,
	] as const;
	private current: ResolvedEnvironment<Client> | null = null;
	private achieved: ResourceActivation = "cache-only";
	private desired: ResourceActivation = "cache-only";
	private inFlight: Promise<Client | null> | null = null;
	private disposeInFlight: Promise<void> = Promise.resolve();
	private disposed = false;
	private retryAttempt = 0;
	private retryCancel: (() => void) | null = null;
	private readonly listeners = new Set<(view: ConnectionView) => void>();
	private readonly retainers = new Map<number, ResourceActivation>();
	private nextRetainer = 0;
	private state: ConnectionView;

	constructor(
		readonly environmentId: EnvironmentId,
		private readonly resolver: EnvironmentResolver<Client>,
		private readonly options: EnvironmentRuntimeOptions = {},
	) {
		this.state = {
			environmentId,
			phase: "dormant",
			generation: 0,
			error: null,
		};
	}

	snapshot(): ConnectionView {
		return this.state;
	}

	currentClient(): Client | null {
		return this.current?.client ?? null;
	}

	subscribe(listener: (view: ConnectionView) => void): () => void {
		this.listeners.add(listener);
		listener(this.state);
		return () => this.listeners.delete(listener);
	}

	retain(activation: ResourceActivation): EnvironmentRuntimeLease<Client> {
		const id = ++this.nextRetainer;
		this.retainers.set(id, activation);
		let released = false;
		void this.reconcileActivation().catch(() => undefined);
		return {
			activate: (next) => {
				if (released) return Promise.resolve(null);
				this.retainers.set(id, next);
				return this.reconcileActivation();
			},
			release: () => {
				if (released) return;
				released = true;
				this.retainers.delete(id);
				void this.reconcileActivation().catch(() => undefined);
			},
		};
	}

	private reconcileActivation(): Promise<Client | null> {
		if (this.disposed) return Promise.reject(new Error("runtime disposed"));
		const previousDesired = this.desired;
		this.desired = this.strongestRetainedActivation();
		if (this.desired === "cache-only" || this.desired === "sync") {
			this.clearRetry();
			this.achieved = this.desired;
			this.closeCurrent();
			this.emit({ phase: "dormant", error: null });
			return Promise.resolve(null);
		}
		// Removing or weakening a retainer must not bypass the supervisor's
		// scheduled backoff and manufacture a competing reconnect. A stronger
		// activation is an explicit user demand and may retry immediately.
		if (
			this.retryCancel !== null &&
			activationRank(this.desired) <= activationRank(previousDesired)
		) {
			return Promise.resolve(this.current?.client ?? null);
		}
		// An escalated activation is an explicit user demand: it starts a fresh
		// retry episode with visible progress instead of a quiet background one.
		if (activationRank(this.desired) > activationRank(previousDesired)) {
			this.retryAttempt = 0;
		}
		this.clearRetry();
		if (this.platformOffline()) {
			this.emit({ phase: "offline", error: null });
			this.scheduleRetry();
			return Promise.reject(new Error("offline"));
		}
		if (this.current !== null) {
			// A responsive runtime connection proves the environment is already
			// awake. Escalating a retained surface from connect to wake must not
			// tear down that connection and manufacture a new generation.
			this.achieved = strongestActivation(this.achieved, this.desired);
			return Promise.resolve(this.current.client);
		}
		if (this.inFlight !== null) return this.inFlight;
		const pending = this.resolveDesired();
		this.inFlight = pending;
		void pending.then(
			() => {
				if (this.inFlight === pending) this.inFlight = null;
			},
			() => {
				if (this.inFlight === pending) this.inFlight = null;
			},
		);
		return pending;
	}

	reportFault(fault: EnvironmentFault, expectedGeneration: number): boolean {
		if (this.disposed || expectedGeneration !== this.state.generation) {
			return false;
		}
		// One physical socket backs several resource streams. Its close can be
		// reported by each driver in the same generation; the first report already
		// owns disposal and retry, so later reports must not overwrite the stable
		// reconnecting state with a false terminal failure.
		if (
			this.current === null &&
			this.retryCancel !== null &&
			(fault.phase === "offline" || fault.phase === "failed")
		) {
			return true;
		}
		this.achieved = "cache-only";
		this.desired = this.strongestRetainedActivation();
		this.closeCurrent();
		const retrying =
			fault.phase === "offline" || fault.phase === "failed"
				? this.scheduleRetry(fault.phase)
				: false;
		this.emit({
			phase:
				fault.phase === "failed" && retrying ? "reconnecting" : fault.phase,
			error: fault.phase === "failed" && retrying ? null : fault.message,
		});
		return true;
	}

	retryNow(): Promise<Client | null> {
		this.retryAttempt = 0;
		this.clearRetry();
		return this.reconcileActivation();
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.desired = "cache-only";
		this.clearRetry();
		this.retainers.clear();
		this.closeCurrent();
		await this.disposeInFlight;
		this.listeners.clear();
	}

	/** Platform connectivity only gates environments reached over the network. */
	private platformOffline(): boolean {
		return (
			(this.options.requiresNetwork?.(this.environmentId) ?? true) &&
			(this.options.isOnline?.() ?? true) === false
		);
	}

	private async resolveDesired(): Promise<Client | null> {
		while (
			!this.disposed &&
			activationRank(this.achieved) < activationRank(this.desired)
		) {
			if (this.current !== null) {
				this.closeCurrent();
				this.achieved = "cache-only";
			}
			await this.disposeInFlight;
			const requested = this.desired as NetworkActivation;
			// Automatic retries remain in one reconnecting state. The surface moves
			// again only on success, terminal exhaustion, or an explicit retry.
			const quietRetry =
				this.retryAttempt > 0 &&
				(this.state.phase === "reconnecting" || this.state.phase === "offline");
			if (!quietRetry) {
				this.emit({
					phase:
						requested === "wake"
							? "waking"
							: this.state.generation === 0
								? "connecting"
								: "reconnecting",
					error: null,
				});
			}
			const outcome = await Effect.runPromise(
				this.resolver.resolve(this.environmentId, requested).pipe(
					Effect.match({
						onFailure: (fault) => ({ ok: false as const, fault }),
						onSuccess: (resolved) => ({ ok: true as const, resolved }),
					}),
				),
			);
			if (
				this.disposed ||
				this.desired === "cache-only" ||
				this.desired === "sync"
			) {
				if (outcome.ok) {
					await outcome.resolved.dispose().catch(() => undefined);
				}
				this.achieved = "cache-only";
				if (!this.disposed) this.emit({ phase: "dormant", error: null });
				return null;
			}
			if (!outcome.ok) {
				this.achieved = "cache-only";
				const retrying =
					outcome.fault.phase === "offline" || outcome.fault.phase === "failed"
						? this.scheduleRetry(outcome.fault.phase)
						: false;
				this.emit({
					phase:
						outcome.fault.phase === "failed" && retrying
							? "reconnecting"
							: outcome.fault.phase,
					error:
						outcome.fault.phase === "failed" && retrying
							? null
							: outcome.fault.message,
				});
				if (!retrying) {
					this.desired = "cache-only";
				}
				throw new Error(outcome.fault.message);
			}
			this.current = outcome.resolved;
			// Credit only the resolver activation that actually completed. A wake
			// retainer may arrive while a weaker connect is in flight; marking the
			// weaker result as wake-capable would let clients run before the resolver's
			// wake side effect ever executes.
			this.achieved = requested;
			if (activationRank(this.achieved) < activationRank(this.desired)) {
				continue;
			}
			this.retryAttempt = 0;
			this.emit({
				phase: "connected",
				generation: this.state.generation + 1,
				error: null,
			});
			outcome.resolved.onActivated?.(this.state.generation);
		}
		return this.current?.client ?? null;
	}

	private closeCurrent(): void {
		const current = this.current;
		this.current = null;
		if (current !== null) {
			this.disposeInFlight = this.disposeInFlight
				.then(current.dispose)
				.catch(() => undefined);
		}
	}

	private emit(patch: Partial<Omit<ConnectionView, "environmentId">>): void {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener(this.state);
	}

	private scheduleRetry(
		faultPhase: EnvironmentFault["phase"] | ConnectionView["phase"] = this.state
			.phase,
	): boolean {
		if (
			this.disposed ||
			this.desired === "cache-only" ||
			this.desired === "sync" ||
			this.retryCancel !== null
		) {
			return false;
		}
		// A failure that survives the whole backoff ladder is not transient —
		// keep the terminal failed state instead of retrying (and re-waking the
		// environment) forever. A user retry, a stronger activation, or the
		// platform online edge starts a fresh episode. Offline stays unbounded:
		// it emits no oscillating phases and clears on the online edge anyway.
		if (
			faultPhase === "failed" &&
			this.retryAttempt >= EnvironmentRuntime.RETRY_DELAYS_MS.length
		) {
			return false;
		}
		const schedule =
			this.options.schedule ??
			((delayMs: number, task: () => void) => {
				const timer = setTimeout(task, delayMs);
				return () => clearTimeout(timer);
			});
		const random = this.options.random ?? Math.random;
		const baseDelay =
			EnvironmentRuntime.RETRY_DELAYS_MS[
				Math.min(
					this.retryAttempt,
					EnvironmentRuntime.RETRY_DELAYS_MS.length - 1,
				)
			] ?? 10_000;
		this.retryAttempt += 1;
		const delayMs = Math.round(baseDelay * (0.75 + random() * 0.5));
		this.retryCancel = schedule(delayMs, () => {
			this.retryCancel = null;
			if (
				this.disposed ||
				this.desired === "cache-only" ||
				this.desired === "sync"
			)
				return;
			void this.reconcileActivation().catch(() => undefined);
		});
		return true;
	}

	private strongestRetainedActivation(): ResourceActivation {
		let result: ResourceActivation = "cache-only";
		for (const activation of this.retainers.values()) {
			result = strongestActivation(result, activation);
			if (result === "wake") return result;
		}
		return result;
	}

	private clearRetry(): void {
		this.retryCancel?.();
		this.retryCancel = null;
	}
}

export class EnvironmentRuntimeRegistry<Client> {
	private readonly runtimes = new Map<
		EnvironmentId,
		EnvironmentRuntime<Client>
	>();

	constructor(
		private readonly resolver: EnvironmentResolver<Client>,
		private readonly options: EnvironmentRuntimeOptions = {},
	) {}

	get(environmentId: EnvironmentId): EnvironmentRuntime<Client> {
		let runtime = this.runtimes.get(environmentId);
		if (runtime === undefined) {
			runtime = new EnvironmentRuntime(
				environmentId,
				this.resolver,
				this.options,
			);
			this.runtimes.set(environmentId, runtime);
		}
		return runtime;
	}

	snapshots(): readonly ConnectionView[] {
		return [...this.runtimes.values()].map((runtime) => runtime.snapshot());
	}

	/** Immediately wake every retained runtime after an OS/network online edge. */
	retryRetained(): void {
		for (const runtime of this.runtimes.values()) {
			if (runtime.snapshot().phase !== "dormant") {
				void runtime.retryNow().catch(() => undefined);
			}
		}
	}

	async dispose(): Promise<void> {
		const runtimes = [...this.runtimes.values()];
		this.runtimes.clear();
		await Promise.all(runtimes.map((runtime) => runtime.dispose()));
	}
}

export const environmentFault = (
	phase: EnvironmentFault["phase"],
	cause: unknown,
): EnvironmentFault => ({ phase, message: failureMessage(cause) });
