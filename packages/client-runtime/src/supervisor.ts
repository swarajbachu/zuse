import { Data, Effect } from "effect";

import { CommandDispatcher } from "./command-dispatch";
import type { ClientSession } from "./connection";

export type ConnectionStatus =
	| "offline"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "error"
	| "blockedAuth";

export type ConnectionSnapshot = {
	readonly key: string;
	readonly status: ConnectionStatus;
	readonly generation: number;
	readonly attempt: number;
	readonly error: string | null;
};

/** Result of probing a supervised connection after the app resumes. */
export type ConnectionHealth = "healthy" | "replaced" | "pending";

export class ClientConnectionError extends Data.TaggedError(
	"ClientConnectionError",
)<{
	readonly message: string;
	readonly cause: unknown;
}> {}

export type ConnectionDiagnostic = {
	readonly event: string;
	readonly key: string;
	readonly details?: Readonly<Record<string, unknown>>;
};

export type ConnectionSupervisorEntry<Client> = {
	readonly getClient: () => Effect.Effect<Client, ClientConnectionError>;
	readonly reportFailure: (
		cause: unknown,
		expectedGeneration?: number,
	) => boolean;
	readonly dispatchCommand: <A>(
		commandId: string,
		operation: (client: Client) => Promise<A>,
	) => Promise<A>;
	readonly retryNow: () => void;
	/**
	 * Probe a live session and replace it immediately when it no longer
	 * answers. A connection waiting out its backoff retries right away.
	 */
	readonly checkHealth: (timeoutMs: number) => Promise<ConnectionHealth>;
	/**
	 * Replace the live session without counting a failure, or skip the
	 * remaining backoff. Used after a long background, where mobile systems
	 * often kill sockets without a close event.
	 */
	readonly replaceSession: () => void;
	readonly remove: () => Promise<void>;
	readonly snapshot: () => ConnectionSnapshot;
	readonly subscribe: (
		listener: (snapshot: ConnectionSnapshot) => void,
	) => () => void;
};

export type ConnectionSupervisorDeps<Options, Client> = {
	readonly keyOf: (options: Options) => string;
	readonly prepareOptions?: (options: Options) => Promise<Options>;
	readonly createClient: (
		options: Options,
		signal: AbortSignal,
	) => Promise<ClientSession<Client>>;
	readonly validateClient?: (client: Client) => Promise<void>;
	readonly isOnline: () => boolean;
	readonly now?: () => number;
	/**
	 * Whether this connection's transport crosses the network. In-process
	 * transports (an Electron IPC bridge) ignore platform offline edges.
	 * Default: true.
	 */
	readonly requiresNetwork?: (options: Options) => boolean;
	readonly schedule: (delayMs: number, fn: () => void) => () => void;
	readonly classifyError?: (cause: unknown) => "auth" | "transient";
	readonly isRetryableCommandError?: (cause: unknown) => boolean;
	readonly isIgnorableFailure?: (cause: unknown) => boolean;
	/** Reconnect when one logical connection receives a new endpoint or credential. */
	readonly shouldReconnectOnOptionsChange?: (
		previous: Options,
		next: Options,
	) => boolean;
	/**
	 * Stop background retry churn after this many consecutive failures. A
	 * function lets one supervisor bound billable cloud connections while
	 * self-hosted computers keep retrying until they come back.
	 */
	readonly maxAutomaticAttempts?: number | ((options: Options) => number);
	/**
	 * Probe the live session before acting on a reported failure. A stale
	 * error from an earlier socket, or one failed stream, then cannot tear
	 * down a healthy connection. A dead socket fails the probe immediately.
	 */
	readonly confirmFailuresWithProbe?: boolean;
	readonly onDiagnostic?: (diagnostic: ConnectionDiagnostic) => void;
};

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 16_000;
/**
 * A session that stayed up this long is healthy: losing it reconnects at once
 * without counting as a failure. Shorter sessions keep their backoff so a
 * socket that drops right after connecting cannot spin at the retry floor.
 */
const STABLE_CONNECTION_MS = 20_000;
/** Deadline for confirming a reported failure on the live session. */
const FAILURE_PROBE_TIMEOUT_MS = 5_000;

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

export const defaultClassifyError = (cause: unknown): "auth" | "transient" => {
	const message = messageOf(cause).toLowerCase();
	return /_(401|403)(?::|$)/.test(message) ||
		message.includes("invalid_dpop_proof") ||
		message.includes("invalid_workos_token") ||
		message.includes("unauthorized") ||
		message.includes("forbidden")
		? "auth"
		: "transient";
};

export const createConnectionSupervisor = <Options, Client>(
	deps: ConnectionSupervisorDeps<Options, Client>,
) => {
	const entries = new Map<string, SupervisorEntryImpl<Options, Client>>();

	const get = (options: Options): ConnectionSupervisorEntry<Client> => {
		const key = deps.keyOf(options);
		let entry = entries.get(key);
		if (entry === undefined) {
			entry = new SupervisorEntryImpl(key, options, deps, () =>
				entries.delete(key),
			);
			entries.set(key, entry);
		} else {
			entry.updateOptions(options);
		}
		return entry;
	};

	const setOnline = (online: boolean): void => {
		for (const entry of entries.values()) entry.setOnline(online);
	};

	const checkHealth = (
		timeoutMs: number,
	): Promise<
		readonly { readonly options: Options; readonly health: ConnectionHealth }[]
	> =>
		Promise.all(
			[...entries.values()].map(async (entry) => ({
				options: entry.currentOptions(),
				health: await entry.checkHealth(timeoutMs),
			})),
		);

	const snapshots = (): readonly ConnectionSnapshot[] =>
		[...entries.values()].map((entry) => entry.snapshot());

	const dispose = async (): Promise<void> => {
		await Promise.all([...entries.values()].map((entry) => entry.remove()));
	};
	const remove = (options: Options): Promise<void> =>
		entries.get(deps.keyOf(options))?.remove() ?? Promise.resolve();

	/** Options of every supervised connection. */
	const optionsList = (): readonly Options[] =>
		[...entries.values()].map((entry) => entry.currentOptions());

	/** Replace the live sessions that match; returns their options. */
	const replaceSessions = (
		filter: (options: Options) => boolean = () => true,
	): readonly Options[] =>
		[...entries.values()].flatMap((entry) => {
			const options = entry.currentOptions();
			if (!filter(options)) return [];
			entry.replaceSession();
			return [options];
		});

	return {
		get,
		setOnline,
		checkHealth,
		optionsList,
		replaceSessions,
		snapshots,
		dispose,
		remove,
	};
};

class SupervisorEntryImpl<Options, Client>
	implements ConnectionSupervisorEntry<Client>
{
	private options: Options;
	private client: Client | null = null;
	private disposeClient: (() => Promise<void>) | null = null;
	private inFlight: Promise<Client> | null = null;
	private attemptController: AbortController | null = null;
	private closeInFlight: Promise<void> = Promise.resolve();
	private retryCancel: (() => void) | null = null;
	private readonly commandDispatcher = new CommandDispatcher();
	private readonly listeners = new Set<
		(snapshot: ConnectionSnapshot) => void
	>();
	private epoch = 0;
	private removed = false;
	private connectedAt: number | null = null;
	/** Failures before the current session; kept until the session proves stable. */
	private carriedAttempts = 0;
	private confirmingFailureEpoch: number | null = null;
	private state: ConnectionSnapshot;

	constructor(
		private readonly key: string,
		options: Options,
		private readonly deps: ConnectionSupervisorDeps<Options, Client>,
		private readonly onRemove: () => void,
	) {
		this.options = options;
		this.state = {
			key,
			status: this.isOnline() ? "connecting" : "offline",
			generation: 0,
			attempt: 0,
			error: null,
		};
		this.diagnostic("entry.created", { status: this.state.status });
	}

	updateOptions(options: Options): void {
		const reconnect =
			this.deps.shouldReconnectOnOptionsChange?.(this.options, options) ===
			true;
		this.options = options;
		if (!reconnect || this.removed) return;
		this.diagnostic("options.updated", { reconnect: true });
		this.clearRetry();
		this.invalidateClient();
		this.emit({
			status: this.isOnline() ? "reconnecting" : "offline",
			attempt: 0,
			error: null,
		});
		if (this.isOnline()) void this.ensureClient().catch(() => undefined);
	}

	snapshot(): ConnectionSnapshot {
		return this.state;
	}

	currentOptions(): Options {
		return this.options;
	}

	subscribe(listener: (snapshot: ConnectionSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.state);
		return () => this.listeners.delete(listener);
	}

	getClient(): Effect.Effect<Client, ClientConnectionError> {
		return Effect.tryPromise({
			try: () => this.ensureClient(),
			catch: (cause) =>
				new ClientConnectionError({ message: messageOf(cause), cause }),
		});
	}

	reportFailure(cause: unknown, expectedGeneration?: number): boolean {
		return this.handleFailure(
			cause,
			expectedGeneration,
			this.deps.confirmFailuresWithProbe === true,
		);
	}

	private handleFailure(
		cause: unknown,
		expectedGeneration: number | undefined,
		confirmWithProbe: boolean,
	): boolean {
		if (this.removed) return false;
		if (this.deps.isIgnorableFailure?.(cause) === true) {
			this.diagnostic("failure.ignored", {
				reason: messageOf(cause),
				status: this.state.status,
			});
			return false;
		}
		if (expectedGeneration === undefined && this.state.status !== "connected") {
			this.diagnostic("failure.ignored", {
				reason: messageOf(cause),
				status: this.state.status,
			});
			return false;
		}
		if (
			expectedGeneration !== undefined &&
			(this.state.status !== "connected" ||
				this.state.generation !== expectedGeneration)
		) {
			this.diagnostic("failure.ignored", {
				reason: messageOf(cause),
				expectedGeneration,
				actualGeneration: this.state.generation,
				status: this.state.status,
			});
			return false;
		}
		this.diagnostic("failure.reported", { reason: messageOf(cause) });
		const client = this.client;
		if (
			confirmWithProbe &&
			this.deps.validateClient !== undefined &&
			client !== null
		) {
			void this.confirmFailure(cause, client);
			return true;
		}
		this.replaceAfterFailure(cause);
		return true;
	}

	replaceSession(): void {
		if (this.removed) return;
		if (this.client !== null && this.state.status === "connected") {
			this.invalidateClient();
			this.reconnectLostSession("session.replace");
			return;
		}
		if (this.state.status === "reconnecting" && this.retryCancel !== null)
			this.retryNow();
	}

	async checkHealth(timeoutMs: number): Promise<ConnectionHealth> {
		if (this.removed) return "pending";
		const client = this.client;
		if (client === null || this.state.status !== "connected") {
			// A foreground edge is fresh evidence; skip the remaining backoff.
			if (this.state.status === "reconnecting" && this.retryCancel !== null) {
				this.diagnostic("health.retry_backoff");
				this.retryNow();
			}
			return "pending";
		}
		const epoch = this.epoch;
		const failure = await this.probe(client, timeoutMs);
		if (failure === null) return "healthy";
		if (this.removed || epoch !== this.epoch || this.client !== client)
			return this.state.status === "connected" ? "healthy" : "pending";
		this.diagnostic("health.failed", { reason: messageOf(failure) });
		this.invalidateClient();
		this.reconnectLostSession("health.replace");
		return "replaced";
	}

	/** Resolve null when the session answers, or the failure when it does not. */
	private async probe(client: Client, timeoutMs: number): Promise<unknown> {
		const validate = this.deps.validateClient;
		if (validate === undefined) return null;
		let cancelTimeout: () => void = () => undefined;
		try {
			await Promise.race([
				validate(client),
				new Promise<never>((_, reject) => {
					cancelTimeout = this.deps.schedule(timeoutMs, () =>
						reject(new Error(`health check timed out after ${timeoutMs}ms`)),
					);
				}),
			]);
			return null;
		} catch (cause) {
			return cause;
		} finally {
			cancelTimeout();
		}
	}

	/** One probe at a time decides whether reported failures are real. */
	private async confirmFailure(cause: unknown, client: Client): Promise<void> {
		const epoch = this.epoch;
		if (this.confirmingFailureEpoch === epoch) return;
		this.confirmingFailureEpoch = epoch;
		try {
			const failure = await this.probe(client, FAILURE_PROBE_TIMEOUT_MS);
			if (this.removed || epoch !== this.epoch || this.client !== client)
				return;
			if (failure === null) {
				this.diagnostic("failure.unconfirmed", { reason: messageOf(cause) });
				return;
			}
			this.replaceAfterFailure(failure);
		} finally {
			if (this.confirmingFailureEpoch === epoch)
				this.confirmingFailureEpoch = null;
		}
	}

	private replaceAfterFailure(cause: unknown): void {
		this.diagnostic("failure.replace", { reason: messageOf(cause) });
		const stable = this.isStable();
		this.invalidateClient();
		if (stable) this.reconnectLostSession("failure.stable_session_lost");
		else this.markFailure(cause, this.carriedAttempts);
	}

	dispatchCommand<A>(
		commandId: string,
		operation: (client: Client) => Promise<A>,
	): Promise<A> {
		const shouldRetry = this.deps.isRetryableCommandError ?? (() => false);
		return this.commandDispatcher.dispatch(
			commandId,
			async () => {
				try {
					return await operation(await this.ensureClient());
				} catch (cause) {
					// A retried command waits for the next session, so its failure
					// replaces the socket without a probe that could leave it parked.
					if (shouldRetry(cause)) this.handleFailure(cause, undefined, false);
					throw cause;
				}
			},
			{ shouldRetry },
		);
	}

	retryNow(): void {
		if (this.removed) return;
		this.clearRetry();
		if (!this.isOnline()) {
			this.emit({ status: "offline", error: null });
			return;
		}
		this.invalidateClient();
		this.emit({
			status: this.state.generation === 0 ? "connecting" : "reconnecting",
			attempt: 0,
			error: null,
		});
		void this.ensureClient().catch(() => undefined);
	}

	setOnline(online: boolean): void {
		if (this.removed) return;
		if (!online) {
			if (!this.needsNetwork()) return;
			this.clearRetry();
			this.invalidateClient();
			this.emit({ status: "offline", error: null });
			return;
		}
		if (this.state.status === "offline") {
			this.emit({ status: "reconnecting", error: null });
			this.retryNow();
		}
	}

	async remove(): Promise<void> {
		if (this.removed) return;
		this.removed = true;
		this.epoch += 1;
		this.attemptController?.abort();
		this.attemptController = null;
		this.clearRetry();
		this.inFlight = null;
		this.commandDispatcher.failPending(new Error("connection removed"));

		this.onRemove();
		await this.closeCurrent();
		this.listeners.clear();
		this.diagnostic("entry.removed");
	}

	private needsNetwork(): boolean {
		return this.deps.requiresNetwork?.(this.options) ?? true;
	}

	private maxAutomaticAttempts(): number {
		const limit = this.deps.maxAutomaticAttempts;
		return typeof limit === "function"
			? limit(this.options)
			: (limit ?? Number.POSITIVE_INFINITY);
	}

	private isOnline(): boolean {
		return !this.needsNetwork() || this.deps.isOnline();
	}

	private async ensureClient(): Promise<Client> {
		if (this.removed) throw new Error("connection removed");
		if (!this.isOnline()) {
			this.emit({ status: "offline", error: null });
			throw new Error("offline");
		}
		if (
			this.state.status === "blockedAuth" ||
			(this.state.status === "error" &&
				this.state.attempt >= this.maxAutomaticAttempts())
		) {
			throw new Error(this.state.error ?? "connection unavailable");
		}
		if (this.client !== null) return this.client;
		if (this.inFlight !== null) return this.inFlight;

		this.clearRetry();
		this.emit({
			status: this.state.generation === 0 ? "connecting" : "reconnecting",
			error: null,
		});
		const epoch = this.epoch;
		const controller = new AbortController();
		this.attemptController = controller;
		const pending = this.connectOnce(epoch, controller.signal);
		this.inFlight = pending;
		try {
			const client = await pending;
			if (this.removed || epoch !== this.epoch)
				throw new Error("connection superseded");
			if (this.inFlight === pending) this.inFlight = null;
			this.client = client;
			this.connectedAt = this.now();
			this.carriedAttempts = this.state.attempt;
			const reconnect = this.state.generation > 0;
			this.emit({
				status: "connected",
				generation: this.state.generation + 1,
				attempt: 0,
				error: null,
			});
			this.diagnostic("connection.ready", {
				generation: this.state.generation,
			});
			if (reconnect) this.commandDispatcher.redispatchPending();
			return client;
		} catch (cause) {
			if (this.inFlight === pending) this.inFlight = null;
			if (!this.removed && epoch === this.epoch) this.markFailure(cause);
			throw cause;
		} finally {
			if (this.attemptController === controller) this.attemptController = null;
		}
	}

	private async connectOnce(
		epoch: number,
		signal: AbortSignal,
	): Promise<Client> {
		await this.closeInFlight;
		const prepare =
			this.deps.prepareOptions ??
			((options: Options) => Promise.resolve(options));
		const prepared = await prepare(this.options);
		if (this.removed || epoch !== this.epoch)
			throw new Error("connection superseded");
		const session = await this.deps.createClient(prepared, signal);
		if (this.removed || epoch !== this.epoch) {
			await session.dispose().catch(() => undefined);
			throw new Error("connection superseded");
		}
		try {
			await this.deps.validateClient?.(session.client);
			if (this.removed || epoch !== this.epoch)
				throw new Error("connection superseded");
			this.disposeClient = session.dispose;
			return session.client;
		} catch (cause) {
			await session.dispose().catch(() => undefined);
			throw cause;
		}
	}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	private isStable(): boolean {
		return (
			this.connectedAt !== null &&
			this.now() - this.connectedAt >= STABLE_CONNECTION_MS
		);
	}

	/** Replace a session that was healthy; this is not a failed attempt. */
	private reconnectLostSession(event: string): void {
		this.carriedAttempts = 0;
		this.clearRetry();
		this.diagnostic(event);
		if (!this.isOnline()) {
			this.emit({ status: "offline", error: null });
			return;
		}
		this.emit({ status: "reconnecting", attempt: 0, error: null });
		void this.ensureClient().catch(() => undefined);
	}

	private markFailure(
		cause: unknown,
		previousAttempts = this.state.attempt,
	): void {
		if (!this.isOnline()) {
			this.emit({ status: "offline", error: null });
			return;
		}
		const classify = this.deps.classifyError ?? defaultClassifyError;
		if (classify(cause) === "auth") {
			this.emit({ status: "blockedAuth", error: messageOf(cause) });
			return;
		}
		const attempt = previousAttempts + 1;
		if (attempt >= this.maxAutomaticAttempts()) {
			this.emit({ status: "error", attempt, error: messageOf(cause) });
			this.diagnostic("retry.exhausted", {
				attempt,
				reason: messageOf(cause),
			});
			return;
		}
		this.emit({ status: "reconnecting", attempt, error: messageOf(cause) });
		const delay = Math.min(
			MAX_BACKOFF_MS,
			INITIAL_BACKOFF_MS * 2 ** Math.max(0, attempt - 1),
		);
		this.diagnostic("retry.scheduled", {
			attempt,
			delayMs: delay,
			reason: messageOf(cause),
		});
		this.retryCancel = this.deps.schedule(delay, () => {
			this.retryCancel = null;
			void this.ensureClient().catch(() => undefined);
		});
	}

	private invalidateClient(): void {
		this.epoch += 1;
		this.connectedAt = null;
		this.attemptController?.abort();
		this.attemptController = null;
		this.inFlight = null;
		void this.closeCurrent();
	}

	private closeCurrent(): Promise<void> {
		const dispose = this.disposeClient;
		this.client = null;
		this.disposeClient = null;
		if (dispose !== null) {
			this.closeInFlight = this.closeInFlight
				.then(dispose)
				.catch(() => undefined);
		}
		return this.closeInFlight;
	}

	private clearRetry(): void {
		this.retryCancel?.();
		this.retryCancel = null;
	}

	private emit(patch: Partial<Omit<ConnectionSnapshot, "key">>): void {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener(this.state);
	}

	private diagnostic(
		event: string,
		details?: Readonly<Record<string, unknown>>,
	): void {
		this.deps.onDiagnostic?.({ event, key: this.key, details });
	}
}
