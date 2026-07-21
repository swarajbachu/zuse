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
	readonly remove: () => Promise<void>;
	readonly snapshot: () => ConnectionSnapshot;
	readonly subscribe: (
		listener: (snapshot: ConnectionSnapshot) => void,
	) => () => void;
};

export type ConnectionSupervisorDeps<Options, Client> = {
	readonly keyOf: (options: Options) => string;
	readonly prepareOptions?: (options: Options) => Promise<Options>;
	readonly createClient: (options: Options) => Promise<ClientSession<Client>>;
	readonly validateClient?: (client: Client) => Promise<void>;
	readonly isOnline: () => boolean;
	readonly schedule: (delayMs: number, fn: () => void) => () => void;
	readonly classifyError?: (cause: unknown) => "auth" | "transient";
	readonly isRetryableCommandError?: (cause: unknown) => boolean;
	readonly isIgnorableFailure?: (cause: unknown) => boolean;
	/** Reconnect when one logical connection receives a new endpoint or credential. */
	readonly shouldReconnectOnOptionsChange?: (
		previous: Options,
		next: Options,
	) => boolean;
	/** Stop background retry churn after this many consecutive failures. */
	readonly maxAutomaticAttempts?: number;
	readonly onDiagnostic?: (diagnostic: ConnectionDiagnostic) => void;
};

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 16_000;

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const defaultClassifyError = (cause: unknown): "auth" | "transient" => {
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

	const snapshots = (): readonly ConnectionSnapshot[] =>
		[...entries.values()].map((entry) => entry.snapshot());

	const dispose = async (): Promise<void> => {
		await Promise.all([...entries.values()].map((entry) => entry.remove()));
	};

	return { get, setOnline, snapshots, dispose };
};

class SupervisorEntryImpl<Options, Client>
	implements ConnectionSupervisorEntry<Client>
{
	private options: Options;
	private client: Client | null = null;
	private disposeClient: (() => Promise<void>) | null = null;
	private inFlight: Promise<Client> | null = null;
	private closeInFlight: Promise<void> = Promise.resolve();
	private retryCancel: (() => void) | null = null;
	private readonly commandDispatcher = new CommandDispatcher();
	private readonly listeners = new Set<
		(snapshot: ConnectionSnapshot) => void
	>();
	private epoch = 0;
	private removed = false;
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
			status: deps.isOnline() ? "connecting" : "offline",
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
			status: this.deps.isOnline() ? "reconnecting" : "offline",
			attempt: 0,
			error: null,
		});
		if (this.deps.isOnline()) void this.ensureClient().catch(() => undefined);
	}

	snapshot(): ConnectionSnapshot {
		return this.state;
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
		this.invalidateClient();
		this.markFailure(cause);
		return true;
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
					if (shouldRetry(cause)) this.reportFailure(cause);
					throw cause;
				}
			},
			{ shouldRetry },
		);
	}

	retryNow(): void {
		if (this.removed) return;
		this.clearRetry();
		if (!this.deps.isOnline()) {
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
		this.clearRetry();
		this.inFlight = null;
		this.commandDispatcher.failPending(new Error("connection removed"));
		await this.closeCurrent();
		this.listeners.clear();
		this.onRemove();
		this.diagnostic("entry.removed");
	}

	private async ensureClient(): Promise<Client> {
		if (this.removed) throw new Error("connection removed");
		if (!this.deps.isOnline()) {
			this.emit({ status: "offline", error: null });
			throw new Error("offline");
		}
		if (
			this.state.status === "blockedAuth" ||
			(this.state.status === "error" &&
				this.state.attempt >=
					(this.deps.maxAutomaticAttempts ?? Number.POSITIVE_INFINITY))
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
		const pending = this.connectOnce(epoch);
		this.inFlight = pending;
		try {
			const client = await pending;
			if (this.inFlight === pending) this.inFlight = null;
			this.client = client;
			const reconnect = this.state.generation > 0;
			this.emit({
				status: "connected",
				generation: this.state.generation + 1,
				attempt: 0,
				error: null,
			});
			if (reconnect) this.commandDispatcher.redispatchPending();
			return client;
		} catch (cause) {
			if (this.inFlight === pending) this.inFlight = null;
			if (!this.removed && epoch === this.epoch) this.markFailure(cause);
			throw cause;
		}
	}

	private async connectOnce(epoch: number): Promise<Client> {
		await this.closeInFlight;
		const prepare =
			this.deps.prepareOptions ??
			((options: Options) => Promise.resolve(options));
		const prepared = await prepare(this.options);
		if (this.removed || epoch !== this.epoch)
			throw new Error("connection superseded");
		this.options = prepared;
		const session = await this.deps.createClient(prepared);
		if (this.removed || epoch !== this.epoch) {
			await session.dispose().catch(() => undefined);
			throw new Error("connection superseded");
		}
		this.disposeClient = session.dispose;
		try {
			await this.deps.validateClient?.(session.client);
			return session.client;
		} catch (cause) {
			this.disposeClient = null;
			await session.dispose().catch(() => undefined);
			throw cause;
		}
	}

	private markFailure(cause: unknown): void {
		if (!this.deps.isOnline()) {
			this.emit({ status: "offline", error: null });
			return;
		}
		const classify = this.deps.classifyError ?? defaultClassifyError;
		if (classify(cause) === "auth") {
			this.emit({ status: "blockedAuth", error: messageOf(cause) });
			return;
		}
		const attempt = this.state.attempt + 1;
		const maxAttempts =
			this.deps.maxAutomaticAttempts ?? Number.POSITIVE_INFINITY;
		if (attempt >= maxAttempts) {
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
