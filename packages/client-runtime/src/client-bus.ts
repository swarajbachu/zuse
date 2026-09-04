import type {
	CommandAcceptance,
	CommandId,
	CommandStatus,
	EnvironmentId,
} from "@zuse/contracts";

import type {
	ClientCommand,
	ClientCommandExecutor,
	CloudCommandTransport,
	CommandDispatchHandle,
	CommandFingerprint,
	CommandOutbox,
	CommandReceipt,
	OutboxEntry,
	PreparedCloudCommandHandle,
	ResourcePersistence,
} from "./client-persistence";
import {
	assertCommandFingerprint,
	CloudCommandTerminalError,
	CloudCommandTransportUnavailableError,
	commandFingerprint,
	terminalCommandReceipt,
	terminalErrorFromReceipt,
} from "./client-persistence";
import {
	type EnvironmentFault,
	type EnvironmentResolver,
	type EnvironmentRuntime,
	type EnvironmentRuntimeLease,
	type EnvironmentRuntimeOptions,
	EnvironmentRuntimeRegistry,
	type ResourceActivation,
} from "./environment-runtime";
import {
	type ResourceData,
	type ResourceKey,
	resourceKeyId,
} from "./resource-ref";
import {
	type ConnectionView,
	emptyResourceView,
	type FailedCommand,
	type PendingCommand,
	type ResourceCursor,
	type ResourceView,
	type SyncPhase,
} from "./resource-state";

const pendingCommandWithDeliveryStatus = (
	command: PendingCommand,
	status: CommandStatus,
): PendingCommand => ({
	...command,
	deliveryPhase:
		status.state === "accepted" ? "waiting-for-runtime" : status.state,
	category: status.category,
	blockedUntil: status.blockedUntil,
	cancellable:
		!status.everLeased &&
		(status.state === "accepted" ||
			status.state === "waiting-for-runtime" ||
			status.state === "blocked"),
});

export type ResourceDriverUpdate<Data> = Readonly<{
	data?: Data;
	cursor?: ResourceCursor;
	sync?: SyncPhase;
	persist?: boolean;
	resetEpoch?: boolean;
	/** Advance the canonical cell without rendering an intermediate replay frame. */
	notify?: boolean;
}>;

export type ResourceDataUpdate<Data> = Readonly<{
	/** Connection generation which issued the side request. */
	expectedGeneration: number;
	/** Durable cursor observed before the side request started. */
	expectedCursor: ResourceCursor | null;
	/** Returning undefined rejects the update without notifying subscribers. */
	update: (data: Data) => Data | undefined;
	persist?: boolean;
}>;

export type ResourceOverlayUpdate<Data> = Readonly<{
	/** Seed for a new canonical cell before its first cache/runtime snapshot. */
	initialData?: Data;
	/** Returning undefined rejects the update without notifying subscribers. */
	update: (data: Data) => Data | undefined;
	persist?: boolean;
}>;

export type ResourceDriverContext<Client, Data> = Readonly<{
	key: ResourceKey<Data>;
	client: Client;
	generation: number;
	data: Data | null;
	cursor: ResourceCursor | null;
	/** Current fenced resource view, including side-request data updates. */
	snapshot: () => ResourceView<Data> | null;
	/** Fence side-channel sinks (for example xterm bytes) before mutating them. */
	isCurrent: () => boolean;
	emit: (update: ResourceDriverUpdate<Data>) => boolean;
}>;

export interface ResourceDriver<Client, Data> {
	readonly start: (
		context: ResourceDriverContext<Client, Data>,
	) => void | Promise<void>;
	readonly stop: () => void;
}

export type ResourceDriverFactory<Client> = (
	key: ResourceKey<unknown>,
) => ResourceDriver<Client, unknown> | null;

export type ResourceSynchronization<Data> = Readonly<{
	data: Data;
	cursor: ResourceCursor;
	resetEpoch?: boolean;
}>;

export interface ResourceSynchronizer {
	readonly synchronize: <Data>(
		key: ResourceKey<Data>,
		current: ResourceView<Data>,
	) => Promise<ResourceSynchronization<Data> | null>;
}

export type ResourceLease = Readonly<{
	release: () => void;
	activate: (activation: ResourceActivation) => void;
}>;

export type ClientBusOptions<Client> = Readonly<{
	resolver: EnvironmentResolver<Client>;
	persistence?: ResourcePersistence;
	outbox?: CommandOutbox;
	commandExecutor?: ClientCommandExecutor<Client>;
	/** Stable control-plane transport for eligible cloud environments. */
	commandTransportFor?: (
		environmentId: EnvironmentId,
		kind: string,
	) => CloudCommandTransport | undefined;
	/** Maps transport-level command failures into the shared connection state. */
	commandFaultFor?: (cause: unknown) => EnvironmentFault | null;
	driverFor?: ResourceDriverFactory<Client>;
	synchronizer?: ResourceSynchronizer;
	runtime?: EnvironmentRuntimeOptions;
}>;

type ResourceEntry = {
	readonly id: string;
	readonly key: ResourceKey<unknown>;
	view: ResourceView<unknown>;
	readonly listeners: Set<(view: ResourceView<unknown>) => void>;
	readonly activations: Map<number, ResourceActivation>;
	nextLeaseId: number;
	runtimeLease: EnvironmentRuntimeLease<unknown> | null;
	driverEpoch: number;
	driverGeneration: number;
	driverCleanup: (() => void) | null;
	persistenceTail: Promise<void>;
	hydration: Promise<void> | null;
	hydrated: boolean;
	runtimeUpdates: number;
	synchronization: Promise<void> | null;
	synchronizationEpoch: number;
};

type EnvironmentBinding<Client> = {
	readonly environmentId: EnvironmentId;
	readonly resourceIds: Set<string>;
	unsubscribe: () => void;
	lastOutboxFlushGeneration: number;
	flushInFlight: Promise<void> | null;
	readonly runtime: EnvironmentRuntime<Client>;
};

type CommandLaneReservation = Readonly<{
	waitForTurn: Promise<void>;
	release: () => void;
}>;

type CommandAcceptanceOwner = Readonly<{
	readonly fingerprint: CommandFingerprint;
	readonly accepted: Promise<CommandAcceptance>;
	readonly resolveAccepted: (acceptance: CommandAcceptance) => void;
	readonly rejectAccepted: (cause: unknown) => void;
}>;

/** Internal attempt outcome; the original dispatch promise owns the retry. */
class DurableCommandRetrySignal {
	constructor(readonly cause: unknown) {}
}

const cursorIsAccepted = (
	current: ResourceCursor | null,
	next: ResourceCursor | undefined,
	resetEpoch: boolean,
	hasData: boolean,
): boolean => {
	if (next === undefined || current === null) return true;
	if (resetEpoch) return true;
	if (next.epoch !== current.epoch) return false;
	if (next.version === current.version) return !hasData;
	return next.version > current.version;
};

const strongestActivation = (
	activations: Iterable<ResourceActivation>,
): ResourceActivation => {
	let result: ResourceActivation = "cache-only";
	for (const activation of activations) {
		if (activation === "wake") return "wake";
		if (activation === "connect") result = "connect";
		else if (activation === "sync" && result === "cache-only") result = "sync";
	}
	return result;
};

const requestsRuntime = (entry: ResourceEntry): boolean => {
	const activation = strongestActivation(entry.activations.values());
	return activation === "connect" || activation === "wake";
};

const requestsSynchronization = (entry: ResourceEntry): boolean =>
	strongestActivation(entry.activations.values()) !== "cache-only";

const messageOf = (cause: unknown): string => {
	if (cause instanceof Error && cause.message.trim().length > 0) {
		return cause.message;
	}
	if (typeof cause === "object" && cause !== null) {
		const record = cause as Readonly<Record<string, unknown>>;
		const tag = typeof record._tag === "string" ? record._tag : null;
		const reason = typeof record.reason === "string" ? record.reason : null;
		if (tag !== null) {
			return reason !== null && reason.trim().length > 0
				? `${tag}: ${reason}`
				: tag;
		}
		try {
			const encoded = JSON.stringify(cause);
			if (encoded !== undefined && encoded !== "{}") return encoded;
		} catch {
			// Fall through to the generic representation below.
		}
	}
	const fallback = String(cause);
	return fallback.trim().length > 0 ? fallback : "Unknown command failure";
};

const cursorEquals = (
	left: ResourceCursor | null,
	right: ResourceCursor | null,
): boolean =>
	left === right ||
	(left !== null &&
		right !== null &&
		left.epoch === right.epoch &&
		left.version === right.version);

/**
 * The single client-side ownership boundary for environment connections,
 * resource subscriptions, canonical snapshots, cache hydration, and outbox
 * dispatch. UI adapters retain keys and observe keyed cells; transport adapters
 * are ResourceDrivers and cannot mutate another resource.
 */
export class ClientBus<Client> {
	private readonly runtimes: EnvironmentRuntimeRegistry<Client>;
	private readonly entries = new Map<string, ResourceEntry>();
	private readonly environments = new Map<
		EnvironmentId,
		EnvironmentBinding<Client>
	>();
	private readonly commands = new Map<
		CommandId,
		Readonly<{
			fingerprint: CommandFingerprint;
			receipt: Promise<CommandReceipt<unknown>>;
		}>
	>();
	private readonly commandLanes = new Map<string, Promise<void>>();
	private readonly completedReceipts = new Map<
		CommandId,
		CommandReceipt<unknown>
	>();
	private readonly commandAcceptances = new Map<
		CommandId,
		CommandAcceptanceOwner
	>();
	private readonly commandCancels = new Map<
		CommandId,
		() => Promise<import("@zuse/contracts").CommandStatus>
	>();
	private readonly cloudCommandAttemptDisposers = new Set<() => void>();
	private readonly disposalListeners = new Set<(cause: Error) => void>();
	private durableOutboxRetry: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;

	constructor(private readonly options: ClientBusOptions<Client>) {
		this.runtimes = new EnvironmentRuntimeRegistry(
			options.resolver,
			options.runtime,
		);
		if (options.commandTransportFor !== undefined)
			this.scheduleDurableOutboxFlush(0);
	}

	retain<Key extends ResourceKey<unknown>>(
		key: Key,
		options: { readonly activation: ResourceActivation },
	): ResourceLease {
		this.assertActive();
		const entry = this.entry(key);
		const binding = this.environment(key.ref.environmentId);
		binding.resourceIds.add(entry.id);
		const connection = binding.runtime.snapshot();
		if (
			entry.view.connection !== connection.phase ||
			entry.view.generation !== connection.generation
		) {
			this.setView(entry, {
				...entry.view,
				connection: connection.phase,
				generation: connection.generation,
			});
		}
		const leaseId = ++entry.nextLeaseId;
		entry.activations.set(leaseId, options.activation);
		const requestedActivation = strongestActivation(entry.activations.values());

		if (entry.runtimeLease === null) {
			entry.runtimeLease = binding.runtime.retain(
				requestedActivation,
			) as EnvironmentRuntimeLease<unknown> | null;
		} else {
			void entry.runtimeLease
				.activate(requestedActivation)
				.catch(() => undefined);
		}
		const runtimeLease = entry.runtimeLease;
		if (runtimeLease === null) {
			throw new Error(
				`Environment runtime did not return a lease for ${entry.id}`,
			);
		}
		void runtimeLease
			.activate(requestedActivation)
			.then(() => {
				if (entry.activations.size > 0 && requestsRuntime(entry)) {
					this.startDriver(entry, binding);
				}
			})
			.catch(() => undefined);
		this.hydrate(entry);
		this.startSynchronizationAfterHydration(entry);

		let released = false;
		return {
			activate: (activation) => {
				if (released) return;
				entry.activations.set(leaseId, activation);
				const strongest = strongestActivation(entry.activations.values());
				if (strongest === "cache-only" || strongest === "sync") {
					this.stopDriver(entry);
					if (strongest === "cache-only") entry.synchronizationEpoch += 1;
					if (entry.view.data !== null) {
						this.setView(entry, { ...entry.view, sync: "cached" });
					}
				}
				void entry.runtimeLease?.activate(strongest).then(
					() => {
						if (entry.activations.size > 0 && requestsRuntime(entry)) {
							this.startDriver(entry, binding);
						}
					},
					() => undefined,
				);
				this.startSynchronizationAfterHydration(entry);
			},
			release: () => {
				if (released) return;
				released = true;
				entry.activations.delete(leaseId);
				if (entry.activations.size > 0) {
					const strongest = strongestActivation(entry.activations.values());
					if (strongest === "cache-only" || strongest === "sync") {
						this.stopDriver(entry);
						if (strongest === "cache-only") entry.synchronizationEpoch += 1;
						if (entry.view.data !== null) {
							this.setView(entry, { ...entry.view, sync: "cached" });
						}
					}
					void entry.runtimeLease?.activate(strongest).then(
						() => {
							if (requestsRuntime(entry)) this.startDriver(entry, binding);
						},
						() => undefined,
					);
					return;
				}
				entry.runtimeLease?.release();
				entry.runtimeLease = null;
				binding.resourceIds.delete(entry.id);
				this.stopDriver(entry);
				entry.synchronizationEpoch += 1;
				if (entry.view.data !== null) {
					this.setView(entry, {
						...entry.view,
						sync: "cached",
					});
				}
			},
		};
	}

	snapshot<Key extends ResourceKey<unknown>>(
		key: Key,
	): ResourceView<ResourceData<Key>> {
		return this.entry(key).view as ResourceView<ResourceData<Key>>;
	}

	subscribe<Key extends ResourceKey<unknown>>(
		key: Key,
		listener: (view: ResourceView<ResourceData<Key>>) => void,
	): () => void {
		const entry = this.entry(key);
		const erased = listener as (view: ResourceView<unknown>) => void;
		entry.listeners.add(erased);
		return () => entry.listeners.delete(erased);
	}

	/** Observe an already-created cell without manufacturing a new resource. */
	subscribeIfPresent<Key extends ResourceKey<unknown>>(
		key: Key,
		listener: (view: ResourceView<ResourceData<Key>>) => void,
	): () => void {
		const entry = this.entries.get(resourceKeyId(key));
		if (entry === undefined) return () => undefined;
		const erased = listener as (view: ResourceView<unknown>) => void;
		entry.listeners.add(erased);
		return () => entry.listeners.delete(erased);
	}

	/**
	 * Drops an inactive resource cell so a future surface performs a fresh replay.
	 * Active leases fence this operation; callers must release and unsubscribe first.
	 */
	forget(key: ResourceKey<unknown>): boolean {
		if (this.disposed) return false;
		const id = resourceKeyId(key);
		const entry = this.entries.get(id);
		if (entry === undefined || entry.activations.size > 0) return false;
		this.stopDriver(entry);
		entry.synchronizationEpoch += 1;
		this.entries.delete(id);
		void this.options.persistence?.removeResource(key).catch(() => undefined);
		return true;
	}

	/**
	 * Applies data returned by a bounded side request (for example an older
	 * timeline page) without granting that request ownership of the stream
	 * cursor. Both generation and cursor must still match the view from which
	 * the request was issued, so a reconnect or live advance safely fences it.
	 */
	update<Key extends ResourceKey<unknown>>(
		key: Key,
		options: ResourceDataUpdate<ResourceData<Key>>,
	): boolean {
		if (this.disposed) return false;
		const entry = this.entries.get(resourceKeyId(key));
		if (
			entry === undefined ||
			entry.view.data === null ||
			entry.view.generation !== options.expectedGeneration ||
			!cursorEquals(entry.view.cursor, options.expectedCursor)
		) {
			return false;
		}
		const data = options.update(entry.view.data as ResourceData<Key>);
		if (data === undefined) return false;
		entry.runtimeUpdates += 1;
		const next: ResourceView<unknown> = {
			...entry.view,
			data,
			origin: "runtime",
		};
		this.setView(entry, next);
		if (options.persist === true) this.persist(entry, next);
		return true;
	}

	/**
	 * Applies an immediate optimistic overlay to the canonical resource cell.
	 * Unlike a side request this intentionally does not fence on the live cursor:
	 * command intent is serialized by the resource lane and the next durable
	 * frame reconciles the overlay by stable entity identity.
	 */
	overlay<Key extends ResourceKey<unknown>>(
		key: Key,
		options: ResourceOverlayUpdate<ResourceData<Key>>,
	): boolean {
		if (this.disposed) return false;
		const entry = this.entries.get(resourceKeyId(key));
		if (entry === undefined) return false;
		const current = entry.view.data ?? options.initialData;
		if (current === undefined) return false;
		const data = options.update(current as ResourceData<Key>);
		if (data === undefined) return false;
		entry.runtimeUpdates += 1;
		const next: ResourceView<unknown> = {
			...entry.view,
			data,
			origin: "runtime",
		};
		this.setView(entry, next);
		if (options.persist === true) this.persist(entry, next);
		return true;
	}

	/** Clears acknowledged command failures without mutating canonical data. */
	dismissFailedCommands(key: ResourceKey<unknown>): boolean {
		if (this.disposed) return false;
		const entry = this.entries.get(resourceKeyId(key));
		if (entry === undefined || entry.view.failedCommands.length === 0)
			return false;
		this.setView(entry, { ...entry.view, failedCommands: [] });
		return true;
	}

	connection(environmentId: EnvironmentId): ConnectionView {
		return this.environment(environmentId).runtime.snapshot();
	}

	/**
	 * Bypass scheduled backoff after the platform reports connectivity again.
	 * The registry remains the sole reconnect owner, so many retained surfaces
	 * still create only one transport attempt per environment.
	 */
	retryRetainedConnections(): void {
		if (!this.disposed) this.runtimes.retryRetained();
	}

	retryConnection(environmentId: EnvironmentId): void {
		if (this.disposed) return;
		void this.runtimes
			.get(environmentId)
			.retryNow()
			.catch(() => undefined);
	}

	/**
	 * Restarts one retained resource driver without reconnecting its environment.
	 * This is used when a provisional resource becomes durable after an earlier
	 * subscription was rejected by the server.
	 */
	restart<Key extends ResourceKey<unknown>>(key: Key): boolean {
		if (this.disposed) return false;
		const entry = this.entries.get(resourceKeyId(key));
		const binding = this.environments.get(key.ref.environmentId);
		if (
			entry === undefined ||
			binding === undefined ||
			entry.activations.size === 0 ||
			!requestsRuntime(entry) ||
			binding.runtime.currentClient() === null
		) {
			return false;
		}
		this.stopDriver(entry);
		this.startDriver(entry, binding);
		return true;
	}

	/** Current generation-fenced client for bounded side requests. */
	client(environmentId: EnvironmentId): Client | null {
		return this.environment(environmentId).runtime.currentClient();
	}

	reportConnectionFault(
		environmentId: EnvironmentId,
		fault: EnvironmentFault,
		expectedGeneration: number,
	): boolean {
		return this.environment(environmentId).runtime.reportFault(
			fault,
			expectedGeneration,
		);
	}

	dispatch<Result>(
		command: ClientCommand<unknown, Result>,
	): Promise<CommandReceipt<Result>> {
		this.assertActive();
		if (
			command.resource !== null &&
			command.resource.ref.environmentId !== command.environmentId
		) {
			return Promise.reject(
				new Error("Command resource belongs to another environment"),
			);
		}
		let fingerprint: CommandFingerprint;
		try {
			fingerprint = commandFingerprint(command);
		} catch (cause) {
			return Promise.reject(cause);
		}
		const existing = this.commands.get(command.commandId);
		if (existing !== undefined) {
			try {
				assertCommandFingerprint(
					command.commandId,
					existing.fingerprint,
					fingerprint,
				);
			} catch (cause) {
				return Promise.reject(cause);
			}
			return existing.receipt as Promise<CommandReceipt<Result>>;
		}
		const completed = this.completedReceipts.get(command.commandId);
		if (completed !== undefined) {
			try {
				assertCommandFingerprint(
					command.commandId,
					completed.fingerprint,
					fingerprint,
				);
			} catch (cause) {
				return Promise.reject(cause);
			}
			const terminal = terminalErrorFromReceipt(completed);
			if (terminal !== null) return Promise.reject(terminal);
			return Promise.resolve(completed as CommandReceipt<Result>);
		}
		// The durable mailbox owns per-session ordering, so cloud commands must be
		// accepted concurrently instead of waiting for an earlier command's final
		// result in the local live-RPC lane.
		const durable = this.cloudTransport(command) !== undefined;
		const liveFallbackReservation = durable
			? this.reserveCommandLane(command)
			: undefined;
		const execution = durable
			? this.dispatchWithPersistedReceipt(
					command,
					fingerprint,
					liveFallbackReservation?.waitForTurn,
				)
			: this.enqueueCommand(command, fingerprint);
		const pending = this.untilDisposed(execution);
		if (liveFallbackReservation !== undefined) {
			void pending.then(
				liveFallbackReservation.release,
				liveFallbackReservation.release,
			);
		}
		this.commands.set(command.commandId, {
			fingerprint,
			receipt: pending as Promise<CommandReceipt<unknown>>,
		});
		void pending.then(
			(receipt) => {
				if (!this.disposed) {
					this.completedReceipts.set(command.commandId, receipt);
				}
				this.commands.delete(command.commandId);
			},
			() => this.commands.delete(command.commandId),
		);
		return pending;
	}

	dispatchHandle<Result>(
		command: ClientCommand<unknown, Result>,
	): CommandDispatchHandle<Result> {
		this.assertActive();
		const fingerprint = commandFingerprint(command);
		let acceptance = this.commandAcceptances.get(command.commandId);
		if (acceptance === undefined) {
			acceptance = this.createCommandAcceptanceOwner(fingerprint);
			this.commandAcceptances.set(command.commandId, acceptance);
		} else {
			assertCommandFingerprint(
				command.commandId,
				acceptance.fingerprint,
				fingerprint,
			);
		}
		const result = this.dispatch(command);
		void result.then(
			(receipt) => {
				acceptance.resolveAccepted({
					commandId: command.commandId,
					workspaceSequence: 0,
					revision: 0,
					acceptedAt: receipt.receivedAt,
					state: "accepted",
				} as CommandAcceptance);
				this.commandAcceptances.delete(command.commandId);
				this.commandCancels.delete(command.commandId);
			},
			(cause) => {
				acceptance.rejectAccepted(cause);
				this.commandAcceptances.delete(command.commandId);
				this.commandCancels.delete(command.commandId);
			},
		);
		return {
			accepted: acceptance.accepted,
			result,
			cancel: () => {
				const cancel = this.commandCancels.get(command.commandId);
				return cancel === undefined
					? Promise.reject(new Error("This command can no longer be cancelled"))
					: cancel();
			},
		};
	}

	private createCommandAcceptanceOwner(
		fingerprint: CommandFingerprint,
	): CommandAcceptanceOwner {
		let resolveAccepted!: (acceptance: CommandAcceptance) => void;
		let rejectAccepted!: (cause: unknown) => void;
		const accepted = new Promise<CommandAcceptance>((resolve, reject) => {
			resolveAccepted = resolve;
			rejectAccepted = reject;
		});
		void accepted.catch(() => undefined);
		return {
			fingerprint,
			accepted,
			resolveAccepted,
			rejectAccepted,
		};
	}

	private ownCloudCommandAttempt(
		handle: PreparedCloudCommandHandle<unknown>,
	): () => void {
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			this.cloudCommandAttemptDisposers.delete(release);
			try {
				handle.dispose();
			} catch {
				// Attempt cleanup must never replace an authoritative command outcome.
			}
		};
		this.cloudCommandAttemptDisposers.add(release);
		if (this.disposed) release();
		return release;
	}

	cancelCommand(
		commandId: CommandId,
	): Promise<import("@zuse/contracts").CommandStatus> {
		const cancel = this.commandCancels.get(commandId);
		return cancel === undefined
			? Promise.reject(new Error("This command can no longer be cancelled"))
			: cancel();
	}

	/**
	 * Commands which mutate the same qualified resource execute in submission
	 * order. Different resources retain independent lanes, so a slow Git command
	 * cannot delay terminal input or another session.
	 */
	private enqueueCommand<Result>(
		command: ClientCommand<unknown, Result>,
		fingerprint: CommandFingerprint,
	): Promise<CommandReceipt<Result>> {
		const reservation = this.reserveCommandLane(command);
		const pending = reservation.waitForTurn.then(() =>
			this.dispatchWithPersistedReceipt(command, fingerprint),
		);
		void pending.then(reservation.release, reservation.release);
		return pending;
	}

	private reserveCommandLane(command: ClientCommand): CommandLaneReservation {
		const lane =
			command.resource === null
				? `environment:${command.environmentId}:command:${command.kind}`
				: resourceKeyId(command.resource);
		const waitForTurn = (
			this.commandLanes.get(lane) ?? Promise.resolve()
		).catch(() => undefined);
		let resolveReservation!: () => void;
		const reservation = new Promise<void>((resolve) => {
			resolveReservation = resolve;
		});
		this.commandLanes.set(lane, reservation);
		let released = false;
		return {
			waitForTurn,
			release: () => {
				if (released) return;
				released = true;
				resolveReservation();
				if (this.commandLanes.get(lane) === reservation) {
					this.commandLanes.delete(lane);
				}
			},
		};
	}

	private async dispatchWithPersistedReceipt<Result>(
		command: ClientCommand<unknown, Result>,
		fingerprint: CommandFingerprint,
		liveFallbackTurn?: Promise<void>,
	): Promise<CommandReceipt<Result>> {
		for (;;) {
			this.assertActive();
			const persisted = await this.commandOutbox()?.findReceipt(
				command.commandId,
			);
			this.assertActive();
			if (persisted !== null && persisted !== undefined) {
				assertCommandFingerprint(
					command.commandId,
					persisted.fingerprint,
					fingerprint,
				);
				this.completedReceipts.set(command.commandId, persisted);
				const terminal = terminalErrorFromReceipt(persisted);
				if (terminal !== null) throw terminal;
				return persisted as CommandReceipt<Result>;
			}
			try {
				return await this.prepareAndExecute(
					command,
					fingerprint,
					liveFallbackTurn,
				);
			} catch (cause) {
				if (!(cause instanceof DurableCommandRetrySignal)) throw cause;
				await this.waitForDurableRetry(2_000);
			}
		}
	}

	private untilDisposed<Value>(promise: Promise<Value>): Promise<Value> {
		if (this.disposed) return Promise.reject(new Error("ClientBus disposed"));
		return new Promise<Value>((resolve, reject) => {
			const onDisposed = (cause: Error) => {
				this.disposalListeners.delete(onDisposed);
				reject(cause);
			};
			this.disposalListeners.add(onDisposed);
			void promise.then(
				(value) => {
					if (!this.disposalListeners.delete(onDisposed)) return;
					resolve(value);
				},
				(cause) => {
					if (!this.disposalListeners.delete(onDisposed)) return;
					reject(cause);
				},
			);
		});
	}

	private waitForDurableRetry(delayMs: number): Promise<void> {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const delay = new Promise<void>((resolve) => {
			timeout = setTimeout(resolve, delayMs);
		});
		return this.untilDisposed(delay).finally(() => {
			if (timeout !== undefined) clearTimeout(timeout);
		});
	}

	async flushOutbox(environmentId?: EnvironmentId): Promise<void> {
		const outbox = this.commandOutbox();
		if (outbox === undefined) return;
		const entries = await outbox.listOutbox(environmentId);
		await Promise.all(
			entries.map((entry) =>
				this.dispatch(entry.command).then(
					() => undefined,
					() => undefined,
				),
			),
		);
	}

	private scheduleDurableOutboxFlush(delayMs: number): void {
		if (this.disposed || this.durableOutboxRetry !== null) return;
		this.durableOutboxRetry = setTimeout(() => {
			this.durableOutboxRetry = null;
			void this.flushDurableOutboxEntries();
		}, delayMs);
	}

	/**
	 * Resumes mailbox-capable rows without requiring a live environment
	 * connection. Renderers call this when a durable environment becomes known
	 * after ClientBus construction (for example, after catalog hydration).
	 */
	async flushDurableOutbox(environmentId?: EnvironmentId): Promise<void> {
		await this.flushDurableOutboxEntries(environmentId);
	}

	private async flushDurableOutboxEntries(
		environmentId?: EnvironmentId,
	): Promise<void> {
		const outbox = this.commandOutbox();
		if (this.disposed || outbox === undefined) return;
		const eligible = (await outbox.listOutbox(environmentId)).filter(
			(entry) =>
				!this.commands.has(entry.command.commandId) &&
				this.cloudTransportForOutboxEntry(entry) !== undefined,
		);
		if (eligible.length === 0) return;
		await Promise.allSettled(
			eligible.map((entry) => this.dispatch(entry.command)),
		);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.durableOutboxRetry !== null) {
			clearTimeout(this.durableOutboxRetry);
			this.durableOutboxRetry = null;
		}
		const disposed = new Error("ClientBus disposed");
		for (const reject of this.disposalListeners) reject(disposed);
		this.disposalListeners.clear();
		for (const acceptance of this.commandAcceptances.values()) {
			acceptance.rejectAccepted(disposed);
		}
		this.commandAcceptances.clear();
		for (const disposeAttempt of [...this.cloudCommandAttemptDisposers])
			disposeAttempt();
		this.cloudCommandAttemptDisposers.clear();
		this.commandCancels.clear();
		this.commands.clear();
		for (const entry of this.entries.values()) this.stopDriver(entry);
		for (const binding of this.environments.values()) binding.unsubscribe();
		await Promise.all(
			[...this.entries.values()].map((entry) => entry.persistenceTail),
		);
		this.environments.clear();
		this.entries.clear();
		this.commandLanes.clear();
		this.completedReceipts.clear();
		await this.runtimes.dispose();
	}

	private entry(key: ResourceKey<unknown>): ResourceEntry {
		const id = resourceKeyId(key);
		let entry = this.entries.get(id);
		if (entry === undefined) {
			entry = {
				id,
				key,
				view: emptyResourceView(),
				listeners: new Set(),
				activations: new Map(),
				nextLeaseId: 0,
				runtimeLease: null,
				driverEpoch: 0,
				driverGeneration: 0,
				driverCleanup: null,
				persistenceTail: Promise.resolve(),
				hydration: null,
				hydrated: this.options.persistence === undefined,
				runtimeUpdates: 0,
				synchronization: null,
				synchronizationEpoch: 0,
			};
			this.entries.set(id, entry);
		}
		return entry;
	}

	private environment(
		environmentId: EnvironmentId,
	): EnvironmentBinding<Client> {
		let binding = this.environments.get(environmentId);
		if (binding !== undefined) return binding;
		const runtime = this.runtimes.get(environmentId);
		binding = {
			environmentId,
			resourceIds: new Set(),
			unsubscribe: () => undefined,
			lastOutboxFlushGeneration: 0,
			flushInFlight: null,
			runtime,
		};
		const unsubscribe = runtime.subscribe((view) =>
			this.onConnection(binding as EnvironmentBinding<Client>, view),
		);
		binding.unsubscribe = unsubscribe;
		this.environments.set(environmentId, binding);
		return binding;
	}

	private onConnection(
		binding: EnvironmentBinding<Client>,
		connection: ConnectionView,
	): void {
		for (const id of binding.resourceIds) {
			const entry = this.entries.get(id);
			if (entry === undefined) continue;
			this.setView(entry, {
				...entry.view,
				connection: connection.phase,
				generation: connection.generation,
			});
			if (connection.phase === "connected" && requestsRuntime(entry)) {
				this.startDriver(entry, binding);
			} else if (entry.driverGeneration !== 0) this.stopDriver(entry);
		}
		if (
			connection.phase === "connected" &&
			connection.generation > binding.lastOutboxFlushGeneration &&
			binding.flushInFlight === null
		) {
			binding.lastOutboxFlushGeneration = connection.generation;
			const flush = this.flushOutbox(binding.environmentId);
			binding.flushInFlight = flush;
			void flush.then(
				() => {
					if (binding.flushInFlight === flush) binding.flushInFlight = null;
				},
				() => {
					if (binding.flushInFlight === flush) binding.flushInFlight = null;
				},
			);
		}
	}

	private hydrate(entry: ResourceEntry): void {
		const persistence = this.options.persistence;
		if (
			persistence === undefined ||
			entry.hydrated ||
			entry.hydration !== null
		) {
			return;
		}
		const initialView = entry.view;
		const initialRuntimeUpdates = entry.runtimeUpdates;
		let restartDriverFromCache = false;
		if (initialView.data === null) {
			this.setView(entry, { ...initialView, sync: "hydrating-cache" });
		}
		const hydration = persistence
			.loadResource(entry.key)
			.then((cached) => {
				if (
					cached === null ||
					entry.runtimeUpdates !== initialRuntimeUpdates ||
					entry.view.origin === "runtime" ||
					entry.view.data !== null
				) {
					if (entry.view.sync === "hydrating-cache") {
						this.setView(entry, { ...entry.view, sync: "empty" });
					}
					return;
				}
				this.setView(entry, {
					...entry.view,
					data: cached.data,
					origin: "cache",
					cursor: cached.cursor,
					sync:
						entry.view.connection === "connected" ? "synchronizing" : "cached",
				});
				restartDriverFromCache = entry.driverGeneration !== 0;
			})
			.catch(() => {
				if (entry.view.sync === "hydrating-cache") {
					this.setView(entry, { ...entry.view, sync: "empty" });
				}
			})
			.then(() => {
				entry.hydrated = true;
				entry.hydration = null;
				if (entry.activations.size === 0) return;
				this.startSynchronization(entry);
				if (!requestsRuntime(entry)) return;
				const binding = this.environments.get(entry.key.ref.environmentId);
				if (binding !== undefined) {
					if (restartDriverFromCache) this.stopDriver(entry);
					this.startDriver(entry, binding);
				}
			});
		entry.hydration = hydration;
	}

	private startSynchronizationAfterHydration(entry: ResourceEntry): void {
		if (!requestsSynchronization(entry)) return;
		if (entry.hydrated) {
			this.startSynchronization(entry);
			return;
		}
		void entry.hydration?.then(() => this.startSynchronization(entry));
	}

	private startSynchronization(entry: ResourceEntry): void {
		const synchronizer = this.options.synchronizer;
		if (
			synchronizer === undefined ||
			entry.synchronization !== null ||
			!requestsSynchronization(entry)
		)
			return;
		const epoch = ++entry.synchronizationEpoch;
		const runtimeUpdates = entry.runtimeUpdates;
		const initial = entry.view;
		if (initial.data === null || initial.sync === "cached") {
			this.setView(entry, { ...initial, sync: "synchronizing" });
		}
		const pending = synchronizer
			.synchronize(entry.key, entry.view)
			.then(async (result) => {
				if (result === null) {
					if (epoch === entry.synchronizationEpoch) {
						this.setView(entry, {
							...entry.view,
							sync: entry.view.data === null ? "empty" : "cached",
						});
					}
					return;
				}
				if (
					epoch !== entry.synchronizationEpoch ||
					entry.runtimeUpdates !== runtimeUpdates ||
					!requestsSynchronization(entry) ||
					!cursorIsAccepted(
						entry.view.cursor,
						result.cursor,
						result.resetEpoch === true,
						true,
					)
				) {
					if (
						epoch === entry.synchronizationEpoch &&
						entry.view.sync === "synchronizing" &&
						!requestsRuntime(entry)
					) {
						this.setView(entry, {
							...entry.view,
							sync: entry.view.data === null ? "empty" : "cached",
						});
					}
					return;
				}
				const next: ResourceView<unknown> = {
					...entry.view,
					data: result.data,
					origin: "checkpoint",
					cursor: result.cursor,
					sync: requestsRuntime(entry) ? "synchronizing" : "cached",
				};
				if (this.options.persistence !== undefined) {
					await this.options.persistence.saveResource(entry.key, {
						data: next.data,
						cursor: next.cursor,
						storedAt: Date.now(),
					});
				}
				if (
					epoch === entry.synchronizationEpoch &&
					entry.runtimeUpdates === runtimeUpdates
				) {
					this.setView(entry, next);
				}
			})
			.catch(() => {
				if (epoch !== entry.synchronizationEpoch) return;
				this.setView(entry, {
					...entry.view,
					sync: entry.view.data === null ? "failed" : "stale",
				});
			})
			.then(() => {
				if (entry.synchronization === pending) entry.synchronization = null;
			});
		entry.synchronization = pending;
	}

	private startDriver(
		entry: ResourceEntry,
		binding: EnvironmentBinding<Client>,
	): void {
		if (
			entry.activations.size === 0 ||
			!entry.hydrated ||
			!requestsRuntime(entry) ||
			entry.driverGeneration === binding.runtime.snapshot().generation
		) {
			return;
		}
		const client = binding.runtime.currentClient();
		const driver = this.options.driverFor?.(entry.key) ?? null;
		if (client === null || driver === null) return;
		this.stopDriver(entry);
		const driverEpoch = ++entry.driverEpoch;
		const generation = binding.runtime.snapshot().generation;
		entry.driverGeneration = generation;
		this.setView(entry, {
			...entry.view,
			generation,
			sync: "synchronizing",
		});
		entry.driverCleanup = driver.stop;
		void Promise.resolve(
			driver.start({
				key: entry.key,
				client,
				generation,
				data: entry.view.data,
				cursor: entry.view.cursor,
				snapshot: () =>
					driverEpoch === entry.driverEpoch &&
					generation === entry.driverGeneration &&
					generation === entry.view.generation
						? (entry.view as ResourceView<unknown>)
						: null,
				isCurrent: () =>
					driverEpoch === entry.driverEpoch &&
					generation === entry.driverGeneration &&
					generation === entry.view.generation,
				emit: (update) =>
					this.acceptDriverUpdate(entry, generation, driverEpoch, update),
			}),
		).then(
			() => undefined,
			(cause) => {
				if (
					driverEpoch === entry.driverEpoch &&
					generation === entry.driverGeneration
				) {
					this.setView(entry, { ...entry.view, sync: "failed" });
					binding.runtime.reportFault(
						{ phase: "failed", message: messageOf(cause) },
						generation,
					);
				}
			},
		);
	}

	private stopDriver(entry: ResourceEntry): void {
		const cleanup = entry.driverCleanup;
		entry.driverCleanup = null;
		// Give a synchronous driver cleanup one final chance to checkpoint while
		// its generation is still current. The epoch fence closes immediately
		// after cleanup returns, so late stream callbacks remain rejected.
		cleanup?.();
		entry.driverEpoch += 1;
		entry.driverGeneration = 0;
	}

	private acceptDriverUpdate<Data>(
		entry: ResourceEntry,
		generation: number,
		driverEpoch: number,
		update: ResourceDriverUpdate<Data>,
	): boolean {
		if (
			driverEpoch !== entry.driverEpoch ||
			generation !== entry.driverGeneration ||
			generation !== entry.view.generation ||
			!cursorIsAccepted(
				entry.view.cursor,
				update.cursor,
				update.resetEpoch === true,
				update.data !== undefined,
			)
		) {
			return false;
		}
		entry.runtimeUpdates += 1;
		const next: ResourceView<unknown> = {
			...entry.view,
			data: update.data === undefined ? entry.view.data : update.data,
			origin: update.data === undefined ? entry.view.origin : "runtime",
			cursor: update.cursor ?? entry.view.cursor,
			sync: update.sync ?? entry.view.sync,
		};
		if (update.notify === false) entry.view = next;
		else this.setView(entry, next);
		if (update.persist === true && next.data !== null) {
			this.persist(entry, next);
		}
		return true;
	}

	private persist(entry: ResourceEntry, view: ResourceView<unknown>): void {
		if (view.data === null) return;
		entry.persistenceTail = entry.persistenceTail
			.then(() =>
				this.options.persistence?.saveResource(entry.key, {
					data: view.data,
					cursor: view.cursor,
					storedAt: Date.now(),
				}),
			)
			.then(() => undefined)
			.catch(() => undefined);
	}

	private prepareAndExecute<Result>(
		command: ClientCommand<unknown, Result>,
		fingerprint: CommandFingerprint,
		liveFallbackTurn?: Promise<void>,
	): Promise<CommandReceipt<Result>> {
		const executor = this.options.commandExecutor;
		if (executor === undefined) {
			return Promise.reject(new Error("ClientBus has no command executor"));
		}
		const outbox = this.commandOutbox();
		const pending = {
			commandId: command.commandId,
			kind: command.kind,
			submittedAt: Date.now(),
		};
		this.updateCommandResource(command, (view) => ({
			...view,
			pendingCommands: [
				...view.pendingCommands.filter(
					(item) => item.commandId !== command.commandId,
				),
				view.pendingCommands.find(
					(item) => item.commandId === command.commandId,
				) ?? pending,
			],
			failedCommands: view.failedCommands.filter(
				(item) => item.commandId !== command.commandId,
			),
		}));
		return (async () => {
			// Once the command is durably in the outbox, keep it there until the
			// server returns either a receipt or an authoritative domain rejection.
			// Transport loss and failures after a successful response are ambiguous:
			// replaying the same command ID is the only safe recovery.
			let retainForRetry = false;
			let durableDeliveryPending = false;
			let mailboxEnvelopePersisted = false;
			let releaseCloudCommandAttempt: (() => void) | undefined;
			try {
				let previous: OutboxEntry | undefined;
				let serializeLiveFallback = false;
				if (command.retry === "safe") {
					if (outbox === undefined) {
						throw new Error("Retry-safe commands require ClientPersistence");
					}
					const queued = await outbox.listOutbox();
					previous = queued.find(
						(entry) => entry.command.commandId === command.commandId,
					);
					if (previous !== undefined) {
						assertCommandFingerprint(
							command.commandId,
							previous.fingerprint,
							fingerprint,
						);
					}
					await outbox.putOutbox({
						...previous,
						command,
						fingerprint,
						attempts: (previous?.attempts ?? 0) + 1,
						lastAttemptAt: Date.now(),
					});
					retainForRetry = true;
				}
				mailboxEnvelopePersisted = previous?.encryptedEnvelope !== undefined;
				const hasPersistedMailboxIdentity =
					mailboxEnvelopePersisted || previous?.acceptance !== undefined;
				const durableTransport = hasPersistedMailboxIdentity
					? this.configuredCloudTransport(command)
					: this.cloudTransport(command);
				if (hasPersistedMailboxIdentity && durableTransport === undefined) {
					// Once opaque mailbox identity exists, live RPC is no longer a safe
					// fallback: a lost response may hide an accepted server row. Catalog
					// hydration will register the transport and resume these exact bytes.
					durableDeliveryPending = true;
					throw new Error(
						"Durable cloud command transport is not available yet",
					);
				}
				if (durableTransport === undefined && liveFallbackTurn !== undefined) {
					serializeLiveFallback = true;
				}
				if (durableTransport !== undefined) {
					durableDeliveryPending = true;
					assertCommandFingerprint(
						command.commandId,
						fingerprint,
						commandFingerprint(command),
					);
					let handle: PreparedCloudCommandHandle<Result> | undefined;
					let acceptance: CommandAcceptance | undefined;
					let deliveryFingerprint: string | undefined;
					try {
						handle = !hasPersistedMailboxIdentity
							? durableTransport.dispatch<Result>({ command, fingerprint })
							: durableTransport.resume<Result>({
									command,
									fingerprint,
									encryptedEnvelope: previous?.encryptedEnvelope,
									...(previous?.acceptance === undefined
										? {}
										: { acceptance: previous.acceptance }),
									...(previous?.deliveryStatus === undefined
										? {}
										: { deliveryStatus: previous.deliveryStatus }),
								});
						releaseCloudCommandAttempt = this.ownCloudCommandAttempt(handle);
						// Delivery promises can settle while local persistence is still running.
						// Mark every branch handled immediately; callers still await the original
						// promises and receive the same result or rejection.
						void handle.accepted.catch(() => undefined);
						void handle.result.catch(() => undefined);
						void handle.encryptedEnvelope.catch(() => undefined);
						void handle.deliveryFingerprint.catch(() => undefined);
						const preparedIdentity = await Promise.all([
							handle.encryptedEnvelope,
							handle.deliveryFingerprint,
						]);
						const [encryptedEnvelope] = preparedIdentity;
						deliveryFingerprint = preparedIdentity[1];
						const current = (
							await outbox?.listOutbox(command.environmentId)
						)?.find((entry) => entry.command.commandId === command.commandId);
						if (command.retry === "safe" && current === undefined) {
							throw new Error(
								"Durable command disappeared before its envelope was persisted",
							);
						}
						if (current !== undefined) {
							await outbox?.putOutbox({
								...current,
								encryptedEnvelope,
							});
							mailboxEnvelopePersisted = true;
						}
						// Fresh commands cannot leave the client until their opaque envelope is
						// durable. Resumed commands use the same gate but never enqueue again.
						this.assertActive();
						handle.start();
						acceptance = await handle.accepted;
					} catch (cause) {
						if (cause instanceof CloudCommandTerminalError) {
							retainForRetry = false;
							throw cause;
						}
						if (!(cause instanceof CloudCommandTransportUnavailableError))
							throw cause;
						if (hasPersistedMailboxIdentity || mailboxEnvelopePersisted)
							throw cause;
						releaseCloudCommandAttempt?.();
						releaseCloudCommandAttempt = undefined;
						acceptance = undefined;
						durableDeliveryPending = false;
						serializeLiveFallback = true;
					}
					if (acceptance !== undefined) {
						if (handle === undefined) {
							throw new Error("Cloud command handle was not prepared");
						}
						if (deliveryFingerprint === undefined) {
							throw new Error("Cloud command identity was not prepared");
						}
						const acceptedStatus: CommandStatus =
							previous?.deliveryStatus !== undefined &&
							previous.deliveryStatus.revision >= acceptance.revision
								? previous.deliveryStatus
								: {
										commandId: acceptance.commandId,
										workspaceSequence: acceptance.workspaceSequence,
										revision: acceptance.revision,
										fingerprint: deliveryFingerprint,
										state: acceptance.state,
										everLeased: false,
										updatedAt: acceptance.acceptedAt,
									};
						if (outbox !== undefined) {
							const current = (
								await outbox.listOutbox(command.environmentId)
							).find((entry) => entry.command.commandId === command.commandId);
							if (current !== undefined) {
								await outbox.putOutbox({
									...current,
									acceptance,
									deliveryStatus: acceptedStatus,
								});
							}
						}
						// The UI may clear its draft only after both sides have recorded the
						// durable acceptance.
						this.commandAcceptances
							.get(command.commandId)
							?.resolveAccepted(acceptance);
						if (!this.disposed)
							this.commandCancels.set(command.commandId, handle.cancel);
						this.updateCommandResource(command, (view) => ({
							...view,
							pendingCommands: view.pendingCommands.map((item) =>
								item.commandId === command.commandId
									? pendingCommandWithDeliveryStatus(item, acceptedStatus)
									: item,
							),
						}));
						let statusPersistence = Promise.resolve();
						const unsubscribeStatus = handle.subscribeStatus?.((status) => {
							if (this.disposed) return;
							if (status.everLeased)
								this.commandCancels.delete(command.commandId);
							this.updateCommandResource(command, (view) => ({
								...view,
								pendingCommands: view.pendingCommands.map((item) =>
									item.commandId === command.commandId
										? pendingCommandWithDeliveryStatus(item, status)
										: item,
								),
							}));
							statusPersistence = statusPersistence
								.then(async () => {
									const current = (
										await outbox?.listOutbox(command.environmentId)
									)?.find(
										(entry) => entry.command.commandId === command.commandId,
									);
									if (
										current !== undefined &&
										(current.deliveryStatus?.revision ?? -1) < status.revision
									)
										await outbox?.putOutbox({
											...current,
											deliveryStatus: status,
										});
								})
								.catch(() => undefined);
						});
						let receipt: CommandReceipt<Result>;
						try {
							receipt = await handle.result;
						} catch (cause) {
							if (cause instanceof CloudCommandTerminalError)
								retainForRetry = false;
							throw cause;
						} finally {
							unsubscribeStatus?.();
							// A status callback can still have an IndexedDB write queued when the
							// terminal result settles. Drain that serialized tail before atomically
							// completing or removing the outbox row, otherwise the late write can
							// resurrect a command that is already terminal.
							await statusPersistence;
						}
						await outbox?.completeOutbox(receipt);
						this.updateCommandResource(command, (view) => ({
							...view,
							pendingCommands: view.pendingCommands.filter(
								(item) => item.commandId !== command.commandId,
							),
						}));
						return receipt;
					}
				}
				if (serializeLiveFallback) await liveFallbackTurn;
				this.assertActive();
				const binding = this.environment(command.environmentId);
				const commandLease = binding.runtime.retain("wake");
				let executionReceipt: Awaited<
					ReturnType<ClientCommandExecutor<Client>["execute"]>
				>;
				try {
					const client = await commandLease.activate("wake");
					if (client === null) throw new Error("environment did not connect");
					this.assertActive();
					const generation = binding.runtime.snapshot().generation;
					assertCommandFingerprint(
						command.commandId,
						fingerprint,
						commandFingerprint(command),
					);
					try {
						executionReceipt = await executor.execute(client, command);
					} catch (cause) {
						const fault = this.options.commandFaultFor?.(cause) ?? null;
						if (fault !== null) {
							binding.runtime.reportFault(fault, generation);
						} else {
							// A typed application/domain rejection is definitive. Retrying it on
							// every reconnect would leave a poisoned outbox entry forever.
							retainForRetry = false;
						}
						throw cause;
					}
				} finally {
					commandLease.release();
				}
				if (executionReceipt.commandId !== command.commandId) {
					throw new Error("Command receipt ID does not match its request");
				}
				const receipt: CommandReceipt<Result> = {
					commandId: executionReceipt.commandId,
					fingerprint,
					receivedAt: executionReceipt.receivedAt,
					result: executionReceipt.result as Result,
				};
				if (command.retry === "safe") {
					await outbox?.completeOutbox(receipt);
				} else {
					await outbox?.putReceipt?.(receipt);
				}
				this.updateCommandResource(command, (view) => ({
					...view,
					pendingCommands: view.pendingCommands.filter(
						(item) => item.commandId !== command.commandId,
					),
				}));
				return receipt;
			} catch (cause) {
				let terminalPersisted = false;
				if (
					cause instanceof CloudCommandTerminalError &&
					command.retry === "safe" &&
					outbox !== undefined
				) {
					const receipt = terminalCommandReceipt(
						command.commandId,
						fingerprint,
						cause,
					);
					try {
						await outbox.completeOutbox(receipt);
						if (!this.disposed)
							this.completedReceipts.set(command.commandId, receipt);
						terminalPersisted = true;
						retainForRetry = false;
					} catch {
						// Never discard the accepted row if its terminal receipt could not be
						// committed atomically. Re-observe the same mailbox identity and retry
						// the local transaction instead.
						retainForRetry = true;
						durableDeliveryPending = true;
					}
				}
				const awaitingDurableRetry =
					command.retry === "safe" && retainForRetry && durableDeliveryPending;
				if (command.retry === "safe" && !retainForRetry && !terminalPersisted) {
					await outbox
						?.removeOutbox(command.commandId, fingerprint)
						.catch(() => undefined);
				}
				if (awaitingDurableRetry) {
					// Preserve the same public promise, lane reservation, and pending UI
					// while the durable owner retries this exact command identity.
					throw new DurableCommandRetrySignal(cause);
				}
				const failed: FailedCommand = {
					commandId: command.commandId,
					kind: command.kind,
					failedAt: Date.now(),
					error: messageOf(cause),
					retryable: command.retry === "safe" && retainForRetry,
					...(cause instanceof CloudCommandTerminalError
						? {
								terminal: {
									state: cause.state,
									...(cause.category === undefined
										? {}
										: { category: cause.category }),
								},
							}
						: {}),
				};
				this.updateCommandResource(command, (view) => ({
					...view,
					pendingCommands: view.pendingCommands.filter(
						(item) => item.commandId !== command.commandId,
					),
					failedCommands: [
						...view.failedCommands.filter(
							(item) => item.commandId !== command.commandId,
						),
						failed,
					],
				}));
				throw cause;
			} finally {
				releaseCloudCommandAttempt?.();
			}
		})();
	}

	private updateCommandResource(
		command: ClientCommand,
		update: (view: ResourceView<unknown>) => ResourceView<unknown>,
	): void {
		if (this.disposed || command.resource === null) return;
		const entry = this.entry(command.resource);
		this.setView(entry, update(entry.view));
	}

	private setView(entry: ResourceEntry, view: ResourceView<unknown>): void {
		if (view === entry.view) return;
		entry.view = view;
		for (const listener of entry.listeners) listener(view);
	}

	private commandOutbox(): CommandOutbox | undefined {
		if (this.options.outbox !== undefined) return this.options.outbox;
		const candidate = this.options.persistence as
			| (ResourcePersistence & Partial<CommandOutbox>)
			| undefined;
		return typeof candidate?.listOutbox === "function" &&
			typeof candidate.putOutbox === "function" &&
			typeof candidate.removeOutbox === "function" &&
			typeof candidate.findReceipt === "function" &&
			typeof candidate.completeOutbox === "function"
			? (candidate as ResourcePersistence & CommandOutbox)
			: undefined;
	}

	private cloudTransport(
		command: ClientCommand,
	): CloudCommandTransport | undefined {
		const transport = this.configuredCloudTransport(command);
		return transport?.supports(command) === true ? transport : undefined;
	}

	private configuredCloudTransport(
		command: ClientCommand,
	): CloudCommandTransport | undefined {
		return this.options.commandTransportFor?.(
			command.environmentId,
			command.kind,
		);
	}

	private cloudTransportForOutboxEntry(
		entry: OutboxEntry,
	): CloudCommandTransport | undefined {
		return entry.encryptedEnvelope === undefined &&
			entry.acceptance === undefined
			? this.cloudTransport(entry.command)
			: this.configuredCloudTransport(entry.command);
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("ClientBus disposed");
	}
}
