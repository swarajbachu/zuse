import { Context, type Duration, Effect } from "effect";
import { Agent } from "undici";

/** One runtime-owned control-plane pool. Local tools/model streams never use it. */
export class CloudRuntimeWake {
	private lastWall = Date.now();
	private lastMonotonic = performance.now();
	private revision = 0;
	private mailboxRevision = 0;
	private readonly mailboxListeners = new Set<() => void>();
	private signalController = new AbortController();
	private agent = new Agent();
	private readonly listeners = new Set<() => void>();
	private readonly timer: ReturnType<typeof setInterval>;

	constructor() {
		this.timer = setInterval(() => this.observe(), 1000);
		this.timer.unref();
	}

	/** Sleep can stop either clock. Delayed event loops are harmless reconnects, not restarts. */
	observe(wall = Date.now(), monotonic = performance.now()): boolean {
		const wallElapsed = wall - this.lastWall;
		const monotonicElapsed = monotonic - this.lastMonotonic;
		this.lastWall = wall;
		this.lastMonotonic = monotonic;
		if (wallElapsed < 2500 && monotonicElapsed < 2500 && wallElapsed >= -1000)
			return false;
		this.revision++;
		this.nudgeMailbox();
		this.signalController.abort();
		this.signalController = new AbortController();
		const old = this.agent;
		this.agent = new Agent();
		void old.destroy().catch(() => {});
		for (const listener of [...this.listeners]) listener();
		return true;
	}

	get mailboxVersion(): number {
		return this.mailboxRevision;
	}

	/** A command notification wakes the serialized drain, never a gateway or local turn. */
	nudgeMailbox(): void {
		this.mailboxRevision++;
		for (const listener of [...this.mailboxListeners]) listener();
	}

	waitMailbox(since: number, duration: Duration.Input): Effect.Effect<void> {
		return Effect.raceFirst(
			Effect.sleep(duration),
			Effect.callback((resume) => {
				if (this.mailboxRevision !== since) {
					resume(Effect.void);
					return;
				}
				const listener = () => resume(Effect.void);
				this.mailboxListeners.add(listener);
				return Effect.sync(() => this.mailboxListeners.delete(listener));
			}),
		);
	}

	request(url: string, init: RequestInit): Promise<Response> {
		const options = {
			...init,
			signal: AbortSignal.any([
				this.signalController.signal,
				...(init.signal ? [init.signal] : []),
			]),
			dispatcher: this.agent as unknown as RequestInit["dispatcher"],
		};
		return fetch(url, options);
	}

	changed(since = this.revision): Effect.Effect<void> {
		return Effect.callback((resume) => {
			if (this.revision !== since) {
				resume(Effect.void);
				return;
			}
			const listener = () => resume(Effect.void);
			this.listeners.add(listener);
			return Effect.sync(() => this.listeners.delete(listener));
		});
	}

	sleep(duration: Duration.Input): Effect.Effect<void> {
		return Effect.suspend(() =>
			Effect.raceFirst(Effect.sleep(duration), this.changed()),
		);
	}

	/** Only network operations/retry schedules belong here, never command execution. */
	restart<A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
		const self = this;
		return Effect.gen(function* () {
			while (true) {
				const outcome = yield* Effect.raceFirst(
					operation.pipe(Effect.map((value) => ({ value }))),
					self.changed().pipe(Effect.as(null)),
				);
				if (outcome !== null) return outcome.value;
			}
		});
	}

	async close(): Promise<void> {
		clearInterval(this.timer);
		this.signalController.abort();
		this.listeners.clear();
		this.mailboxListeners.clear();
		await this.agent.destroy();
	}
}

export const CloudRuntimeNetwork = Context.Reference<
	CloudRuntimeWake | undefined
>("server/api/CloudRuntimeNetwork", { defaultValue: () => undefined });

export const withCloudRuntimeNetwork = <A, E, R>(
	operation: Effect.Effect<A, E, R>,
) =>
	Effect.gen(function* () {
		const network = yield* Effect.acquireRelease(
			Effect.sync(() => new CloudRuntimeWake()),
			(network) => Effect.promise(() => network.close()),
		);
		return yield* operation.pipe(
			Effect.provideService(CloudRuntimeNetwork, network),
		);
	});

export const runtimeNetworkSleep = (duration: Duration.Input) =>
	Effect.gen(function* () {
		const wake = yield* CloudRuntimeNetwork;
		yield* wake ? wake.sleep(duration) : Effect.sleep(duration);
	});

export const restartRuntimeNetworkOnWake = <A, E, R>(
	operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	Effect.gen(function* () {
		const wake = yield* CloudRuntimeNetwork;
		return yield* wake ? wake.restart(operation) : operation;
	});
