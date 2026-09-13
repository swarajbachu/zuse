import {
	ClientBus,
	type ResourceDriver,
	type ResourceDriverFactory,
	type ResourceSynchronization,
} from "@zuse/client-runtime/client-bus";
import type {
	ClientCommand,
	ClientCommandExecutor,
	CommandFingerprint,
	CommandOutbox,
	CommandReceipt,
	OutboxEntry,
	PersistedResource,
	ResourcePersistence,
} from "@zuse/client-runtime/client-persistence";
import {
	assertCommandFingerprint,
	commandFingerprint,
} from "@zuse/client-runtime/client-persistence";
import { makeCloudCommandTransport } from "@zuse/client-runtime/cloud-command-transport";
import {
	openCloudTranscriptCheckpoint,
	openCloudTranscriptPage,
} from "@zuse/client-runtime/cloud-transcript";
import { environmentFault } from "@zuse/client-runtime/environment-runtime";
import {
	makeResourceKey,
	type ResourceKey,
	resourceKeyId,
	type SessionRef,
	type TerminalRef,
} from "@zuse/client-runtime/resource-ref";
import {
	durableOptimisticSessionMessage,
	sessionMessageCommandReflected,
} from "@zuse/client-runtime/session-message-intent";
import { makeSessionMessagePager } from "@zuse/client-runtime/session-message-pager";
import {
	makeSessionTimelineResourceDriver,
	type SessionTimelineDriverClient,
} from "@zuse/client-runtime/session-timeline-driver";
import {
	makeTerminalResourceDriver,
	type TerminalOutputSink,
	terminalRefFromKey,
	terminalResourceKey,
} from "@zuse/client-runtime/terminal-resource-driver";
import {
	CommandId,
	EnvironmentId,
	type PermissionRequest,
	type PtyId,
	type SessionId,
	type SessionTimelineProjection,
	type Skill,
} from "@zuse/contracts";
import { Cause, Effect, Fiber, Stream } from "effect";

import {
	deletePath,
	messagesPath,
	readClientCommandOutbox,
	readMessagesSnapshot,
	writeClientCommandOutbox,
	writeMessagesSnapshot,
} from "~/offline/cache";
import {
	getConnectionClient,
	isConnectionOnline,
	type MemoizeClient,
	reportConnectionFailure,
} from "~/rpc/connection";
import { isRetryableClientError } from "~/rpc/connection-failures";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

const getCloudControl = async () =>
	(await import("~/rpc/api-client")).cloudControlClient;
const cloudTransport = makeCloudCommandTransport(getCloudControl);

type EnvironmentBinding = Readonly<{
	connKey: string;
	options: WsProtocolOptions;
}>;

const bindings = new Map<EnvironmentId, EnvironmentBinding>();

type RetainedTerminalSink = {
	readonly ownerId: string;
	readonly sink: TerminalOutputSink;
	retainers: number;
};

const terminalSinks = new Map<string, RetainedTerminalSink>();

export class MobileCommandOutbox implements CommandOutbox {
	private loaded: Promise<void> | null = null;
	private readonly entries = new Map<string, OutboxEntry>();
	private readonly receipts = new Map<string, CommandReceipt>();
	private writeTail = Promise.resolve();
	private closed = false;

	private assertOpen(): void {
		if (this.closed) throw new Error("Mobile command outbox was closed");
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.writeTail.catch(() => undefined);
	}

	private load(): Promise<void> {
		this.loaded ??= Effect.runPromise(readClientCommandOutbox()).then(
			(snapshot) => {
				for (const entry of snapshot?.entries ?? []) {
					this.entries.set(entry.command.commandId, entry);
				}
				for (const receipt of snapshot?.receipts ?? []) {
					this.receipts.set(receipt.commandId, receipt);
				}
			},
		);
		return this.loaded;
	}

	private persist(): Promise<void> {
		this.writeTail = this.writeTail
			.catch(() => undefined)
			.then(() =>
				Effect.runPromise(
					writeClientCommandOutbox({
						entries: [...this.entries.values()],
						receipts: [...this.receipts.values()].slice(-512),
					}),
				),
			)
			.then(() => undefined);
		return this.writeTail;
	}

	async putOutbox(entry: OutboxEntry): Promise<void> {
		await this.load();
		this.assertOpen();
		const existing = this.entries.get(entry.command.commandId);
		if (existing !== undefined) {
			assertCommandFingerprint(
				entry.command.commandId,
				existing.fingerprint,
				entry.fingerprint,
			);
		}
		this.entries.set(entry.command.commandId, entry);
		await this.persist();
	}

	async removeOutbox(
		commandId: OutboxEntry["command"]["commandId"],
		fingerprint: CommandFingerprint,
	): Promise<void> {
		await this.load();
		this.assertOpen();
		const existing = this.entries.get(commandId);
		if (existing === undefined) return;
		assertCommandFingerprint(commandId, existing.fingerprint, fingerprint);
		this.entries.delete(commandId);
		await this.persist();
	}

	async findReceipt(
		commandId: OutboxEntry["command"]["commandId"],
	): Promise<CommandReceipt | null> {
		await this.load();
		return this.receipts.get(commandId) ?? null;
	}

	async putReceipt(receipt: CommandReceipt): Promise<void> {
		await this.load();
		this.assertOpen();
		const existing = this.receipts.get(receipt.commandId);
		if (existing !== undefined) {
			assertCommandFingerprint(
				receipt.commandId,
				existing.fingerprint,
				receipt.fingerprint,
			);
		}
		this.receipts.set(receipt.commandId, receipt);
		await this.persist();
	}

	async completeOutbox(receipt: CommandReceipt): Promise<void> {
		await this.load();
		this.assertOpen();
		const pending = this.entries.get(receipt.commandId);
		if (pending !== undefined) {
			assertCommandFingerprint(
				receipt.commandId,
				pending.fingerprint,
				receipt.fingerprint,
			);
		}
		const existing = this.receipts.get(receipt.commandId);
		if (existing !== undefined) {
			assertCommandFingerprint(
				receipt.commandId,
				existing.fingerprint,
				receipt.fingerprint,
			);
		}
		this.entries.delete(receipt.commandId);
		this.receipts.set(receipt.commandId, receipt);
		await this.persist();
	}

	async listOutbox(
		environmentId?: EnvironmentId,
	): Promise<readonly OutboxEntry[]> {
		await this.load();
		return [...this.entries.values()]
			.filter(
				(entry) =>
					environmentId === undefined ||
					entry.command.environmentId === environmentId,
			)
			.sort((left, right) => left.command.createdAt - right.command.createdAt);
	}
}

let commandOutbox = new MobileCommandOutbox();

export const environmentIdForConnection = (
	connKey: string,
	options: WsProtocolOptions,
): EnvironmentId => EnvironmentId.make(options.environmentId ?? connKey);

export const connectionKeyForOptions = (options: WsProtocolOptions): string =>
	options.key ??
	options.environmentId ??
	options.wsBaseUrl ??
	`${options.host}:${options.port}`;

export const sessionTimelineKey = (
	environmentId: EnvironmentId,
	sessionId: SessionId,
) =>
	makeResourceKey<SessionTimelineProjection>("session-timeline", {
		environmentId,
		sessionId,
	} satisfies SessionRef);

const sessionRef = (key: ResourceKey<unknown>): SessionRef | null =>
	key.kind === "session-timeline" && "sessionId" in key.ref ? key.ref : null;

export type MobileSessionSkillsData = Readonly<{
	skills: readonly Skill[];
}>;

export const mobileSessionSkillsKey = (
	environmentId: EnvironmentId,
	sessionId: SessionId,
) =>
	makeResourceKey<MobileSessionSkillsData>("session-skills", {
		environmentId,
		sessionId,
	} satisfies SessionRef);

const skillSessionRef = (key: ResourceKey<unknown>): SessionRef | null =>
	key.kind === "session-skills" && "sessionId" in key.ref ? key.ref : null;

const makeSessionSkillsDriver = (): ResourceDriver<
	MemoizeClient,
	MobileSessionSkillsData
> => {
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	let active = false;
	return {
		start: (context) => {
			const ref = skillSessionRef(context.key);
			if (ref === null) return;
			active = true;
			const epoch = `session-skills:${context.generation}:${crypto.randomUUID()}`;
			let version = 0;
			const program = Stream.runForEach(
				context.client["skill.stream"]({ sessionId: ref.sessionId }),
				(skills) =>
					Effect.sync(() => {
						if (!active || !context.isCurrent()) return;
						version += 1;
						context.emit({
							data: { skills },
							cursor: { epoch, version },
							resetEpoch: version === 1,
							sync: "live",
						});
					}),
			).pipe(
				Effect.andThen(
					Effect.fail(new Error("Session skill stream ended unexpectedly")),
				),
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						if (!active || Cause.hasInterruptsOnly(cause)) return;
						context.emit({ sync: "failed" });
						const binding = bindings.get(ref.environmentId);
						if (binding !== undefined) {
							reportConnectionFailure(binding.options, Cause.squash(cause));
						}
					}),
				),
			);
			fiber = Effect.runFork(program);
		},
		stop: () => {
			active = false;
			const running = fiber;
			fiber = null;
			if (running !== null) void Effect.runPromise(Fiber.interrupt(running));
		},
	};
};

export type MobilePermissionsData = Readonly<{
	requestsById: Readonly<Record<string, PermissionRequest>>;
}>;

export const mobilePermissionsKey = (environmentId: EnvironmentId) =>
	makeResourceKey<MobilePermissionsData>("environment-permissions", {
		environmentId,
	});

const permissionEnvironment = (
	key: ResourceKey<unknown>,
): EnvironmentId | null =>
	key.kind === "environment-permissions" && !("sessionId" in key.ref)
		? key.ref.environmentId
		: null;

const makePermissionDriver = (): ResourceDriver<
	MemoizeClient,
	MobilePermissionsData
> => {
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	let active = false;
	return {
		start: (context) => {
			const environmentId = permissionEnvironment(context.key);
			if (environmentId === null) return;
			active = true;
			const epoch = `permissions:${context.generation}:${crypto.randomUUID()}`;
			let version = 0;
			let requestsById = context.data?.requestsById ?? {};
			const program = Stream.runForEach(
				context.client["permission.requests"]({}),
				(change) =>
					Effect.sync(() => {
						if (!active || !context.isCurrent()) return;
						requestsById =
							context.snapshot()?.data?.requestsById ?? requestsById;
						if (change._tag === "snapshot") {
							requestsById = Object.fromEntries(
								change.requests.map((request) => [request.id, request]),
							);
						} else if (change._tag === "change") {
							requestsById = {
								...requestsById,
								[change.request.id]: change.request,
							};
						} else {
							const next = { ...requestsById };
							delete next[change.requestId];
							requestsById = next;
						}
						version += 1;
						context.emit({
							data: { requestsById },
							cursor: { epoch, version },
							resetEpoch: version === 1,
							sync: "live",
						});
					}),
			).pipe(
				Effect.andThen(
					Effect.fail(new Error("Permission stream ended unexpectedly")),
				),
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						if (!active || Cause.hasInterruptsOnly(cause)) return;
						context.emit({ sync: "failed" });
						const binding = bindings.get(environmentId);
						if (binding !== undefined) {
							reportConnectionFailure(binding.options, Cause.squash(cause));
						}
						bus.reportConnectionFault(
							environmentId,
							environmentFault("failed", Cause.squash(cause)),
							context.generation,
						);
					}),
				),
			);
			fiber = Effect.runFork(program);
		},
		stop: () => {
			active = false;
			const running = fiber;
			fiber = null;
			if (running !== null) void Effect.runPromise(Fiber.interrupt(running));
		},
	};
};

class MobileTimelinePersistence implements ResourcePersistence {
	async loadResource<Data>(
		key: ResourceKey<Data>,
	): Promise<PersistedResource<Data> | null> {
		const ref = sessionRef(key);
		if (ref === null) return null;
		const binding = bindings.get(ref.environmentId);
		if (binding === undefined) return null;
		const snapshot = await Effect.runPromise(
			readMessagesSnapshot(binding.connKey, ref.sessionId),
		);
		if (snapshot === null) return null;
		const cursor = snapshot.cursor ?? {
			epoch: "legacy",
			version: snapshot.appliedVersion,
		};
		return {
			data: snapshot.projection as Data,
			cursor,
			storedAt: snapshot.savedAt,
		};
	}

	async saveResource<Data>(
		key: ResourceKey<Data>,
		value: PersistedResource<Data>,
	): Promise<void> {
		const ref = sessionRef(key);
		const binding = ref === null ? undefined : bindings.get(ref.environmentId);
		if (ref === null || binding === undefined || value.cursor === null) return;
		await Effect.runPromise(
			writeMessagesSnapshot(binding.connKey, ref.sessionId, {
				schemaVersion: 1,
				appliedVersion: value.cursor.version,
				cursor: value.cursor,
				projection: value.data as SessionTimelineProjection,
				savedAt: value.storedAt,
			}),
		);
	}

	async removeResource(key: ResourceKey<unknown>): Promise<void> {
		const ref = sessionRef(key);
		const binding = ref === null ? undefined : bindings.get(ref.environmentId);
		if (ref === null || binding === undefined) return;
		await Effect.runPromise(
			deletePath(messagesPath(binding.connKey, ref.sessionId)),
		);
	}
}

const driverFor: ResourceDriverFactory<MemoizeClient> = (key) => {
	if (permissionEnvironment(key) !== null) {
		return makePermissionDriver() as ResourceDriver<MemoizeClient, unknown>;
	}
	if (skillSessionRef(key) !== null) {
		return makeSessionSkillsDriver() as ResourceDriver<MemoizeClient, unknown>;
	}
	if (terminalRefFromKey(key) !== null) {
		return makeTerminalResourceDriver<MemoizeClient>({
			sinkFor: (terminalKey) =>
				terminalSinks.get(resourceKeyId(terminalKey))?.sink ?? null,
			streamOutput: (client, ref, afterSequence) =>
				client["pty.output"]({
					ptyId: ref.terminalId,
					afterSequence,
					ownerId: terminalSinks.get(resourceKeyId(terminalResourceKey(ref)))
						?.ownerId,
				}),
			reportConnectionFailure: (environmentId, generation, cause) => {
				const binding = bindings.get(environmentId);
				if (binding !== undefined) {
					reportConnectionFailure(binding.options, cause);
				}
				bus.reportConnectionFault(
					environmentId,
					environmentFault("failed", cause),
					generation,
				);
			},
		}) as ResourceDriver<MemoizeClient, unknown>;
	}
	return sessionRef(key) === null
		? null
		: (makeSessionTimelineResourceDriver<
				MemoizeClient & SessionTimelineDriverClient
			>({
				checkpointMs: 200,
				reportFailure: (environmentId, generation, cause) => {
					const binding = bindings.get(environmentId);
					if (binding !== undefined) {
						reportConnectionFailure(binding.options, cause);
					}
					bus.reportConnectionFault(
						environmentId,
						environmentFault("failed", cause),
						generation,
					);
				},
			}) as ReturnType<ResourceDriverFactory<MemoizeClient>>);
};

const commandExecutor: ClientCommandExecutor<MemoizeClient> = {
	execute: async (client, command) => {
		const payload = command.payload as never;
		let result: unknown;
		switch (command.kind) {
			case "permission.decide":
				result = await Effect.runPromise(client["permission.decide"](payload));
				break;
			case "session.rename":
				result = await Effect.runPromise(client["session.rename"](payload));
				break;
			case "session.setRuntimeMode":
				result = await Effect.runPromise(
					client["session.setRuntimeMode"](payload),
				);
				break;
			case "session.setPermissionMode":
				result = await Effect.runPromise(
					client["session.setPermissionMode"](payload),
				);
				break;
			case "fs.writeFile":
				result = await Effect.runPromise(client["fs.writeFile"](payload));
				break;
			case "messages.send":
				result = await Effect.runPromise(client["messages.send"](payload));
				break;
			case "messages.interrupt":
				result = await Effect.runPromise(client["messages.interrupt"](payload));
				break;
			case "messages.queue.add":
				result = await Effect.runPromise(client["messages.queue.add"](payload));
				break;
			case "messages.queue.update":
				result = await Effect.runPromise(
					client["messages.queue.update"](payload),
				);
				break;
			case "messages.queue.delete":
				result = await Effect.runPromise(
					client["messages.queue.delete"](payload),
				);
				break;
			case "messages.queue.reorder":
				result = await Effect.runPromise(
					client["messages.queue.reorder"](payload),
				);
				break;
			case "messages.queue.flush":
				result = await Effect.runPromise(
					client["messages.queue.flush"](payload),
				);
				break;
			case "messages.queue.resume":
				result = await Effect.runPromise(
					client["messages.queue.resume"](payload),
				);
				break;
			case "messages.queue.runNext":
				result = await Effect.runPromise(
					client["messages.queue.runNext"](payload),
				);
				break;
			case "pty.write":
				result = await Effect.runPromise(client["pty.write"](payload));
				break;
			case "pty.resize":
				result = await Effect.runPromise(client["pty.resize"](payload));
				break;
			case "pty.close":
				result = await Effect.runPromise(client["pty.close"](payload));
				break;
			default:
				throw new Error(
					`Unsupported mobile ClientBus command: ${command.kind}`,
				);
		}
		return { commandId: command.commandId, receivedAt: Date.now(), result };
	},
};

const makeBus = () =>
	new ClientBus<MemoizeClient>({
		resolver: {
			resolve: (environmentId, activation) => {
				const binding = bindings.get(environmentId);
				if (binding === undefined) {
					return Effect.fail(
						environmentFault("failed", "Unknown mobile environment"),
					);
				}
				return getConnectionClient(binding.options, activation === "wake").pipe(
					Effect.map((client) => ({
						client,
						dispose: async () => undefined,
					})),
					Effect.mapError((cause) => environmentFault("failed", cause)),
				);
			},
		},
		persistence: new MobileTimelinePersistence(),
		outbox: commandOutbox,
		commandExecutor,
		commandTransportFor: (environmentId, kind) =>
			bindings.get(environmentId)?.options.cloudWorkspaceId !== undefined &&
			kind === "messages.send"
				? cloudTransport
				: undefined,
		commandReflected: sessionMessageCommandReflected,
		synchronizer: {
			synchronize: async <Data>(
				key: ResourceKey<Data>,
				current: { cursor: { epoch: string; version: number } | null },
			) => {
				const ref = sessionRef(key);
				if (
					ref === null ||
					bindings.get(ref.environmentId)?.options.cloudWorkspaceId ===
						undefined
				)
					return null;
				const control = await getCloudControl();
				const result = await Effect.runPromise(
					control["cloud.transcript.get"]({
						workspaceId: ref.environmentId,
						sessionId: ref.sessionId,
					}),
				);
				if (result.checkpoint === null) return null;
				const payload = await openCloudTranscriptCheckpoint(
					ref,
					result.checkpoint,
				);
				return {
					data: payload.projection,
					cursor: payload.cursor,
					resetEpoch:
						current.cursor !== null &&
						current.cursor.epoch !== payload.cursor.epoch,
				} as ResourceSynchronization<Data>;
			},
		},
		commandFaultFor: (cause) =>
			isRetryableClientError(cause) ? environmentFault("failed", cause) : null,
		runtime: { isOnline: isConnectionOnline },
		driverFor,
	});

let bus = makeBus();

export const mobileClientBus = (): ClientBus<MemoizeClient> => bus;

const messagePager = makeSessionMessagePager({
	getBus: mobileClientBus,
	readPage: async (ref, client, cursor, beforeSequence) => {
		if (client !== null)
			return Effect.runPromise(
				client["session.messages.page"]({
					sessionId: ref.sessionId,
					beforeSequence,
					limit: 100,
				}),
			);
		if (
			cursor === null ||
			bindings.get(ref.environmentId)?.options.cloudWorkspaceId === undefined
		)
			return null;
		const control = await getCloudControl();
		const result = await Effect.runPromise(
			control["cloud.transcript.messages.page"]({
				workspaceId: ref.environmentId,
				sessionId: ref.sessionId,
				cursor,
				beforeSequence,
			}),
		);
		return result.page === null
			? null
			: openCloudTranscriptPage(ref, cursor, beforeSequence, result.page);
	},
});
export const loadOlderMobileMessages = messagePager.load;

/** Resume retained resources immediately when the native connectivity owner
 * reports an online/app-active edge. */
export const retryMobileClientBusConnections = (): void =>
	mobileClientBus().retryRetainedConnections();

export const registerMobileEnvironment = (
	connKey: string,
	options: WsProtocolOptions,
): EnvironmentId => {
	const environmentId = environmentIdForConnection(connKey, options);
	bindings.set(environmentId, { connKey, options });
	return environmentId;
};

export const mobilePendingMessageIntents = async (ref: SessionRef) =>
	(await commandOutbox.listOutbox(ref.environmentId)).flatMap((entry) => {
		const message = durableOptimisticSessionMessage(entry, ref);
		return message === null ? [] : [message];
	});

export const dispatchMobileSessionCommandHandle = <Result>(
	command: ClientCommand<unknown, Result>,
) => mobileClientBus().dispatchHandle(command);

export const dispatchMobileSessionCommand = <Result>(
	command: ClientCommand<unknown, Result>,
): Promise<CommandReceipt<Result>> => mobileClientBus().dispatch(command);

/**
 * Durably transfers an editable local draft into the canonical command outbox.
 * Resolves after persistence, then starts delivery in the background. Callers
 * may safely delete their draft only after this function resolves.
 */
export const stageMobileSessionCommand = async <Result>(
	command: ClientCommand<unknown, Result>,
): Promise<void> => {
	const fingerprint = commandFingerprint(command);
	const receipt = await commandOutbox.findReceipt(command.commandId);
	if (receipt !== null) {
		assertCommandFingerprint(
			command.commandId,
			receipt.fingerprint,
			fingerprint,
		);
	} else {
		const existing = (
			await commandOutbox.listOutbox(command.environmentId)
		).find((entry) => entry.command.commandId === command.commandId);
		if (existing !== undefined) {
			assertCommandFingerprint(
				command.commandId,
				existing.fingerprint,
				fingerprint,
			);
		} else {
			await commandOutbox.putOutbox({
				command,
				fingerprint,
				attempts: 0,
				lastAttemptAt: null,
			});
		}
	}
	void mobileClientBus()
		.dispatch(command)
		.catch(() => undefined);
};

export const sessionCommandContext = (
	connKey: string,
	options: WsProtocolOptions,
	sessionId: SessionId,
) => {
	const environmentId = registerMobileEnvironment(connKey, options);
	return {
		environmentId,
		resource: sessionTimelineKey(environmentId, sessionId),
	};
};

export const nextMobileCommandId = (kind: string): CommandId =>
	CommandId.make(`${kind}:${crypto.randomUUID()}`);

export const dispatchMobileSessionCommandResult = async <Result>(options: {
	readonly connKey?: string;
	readonly connection: WsProtocolOptions;
	readonly sessionId: SessionId;
	readonly kind: string;
	readonly payload: unknown;
	readonly commandId?: CommandId;
}): Promise<Result> => {
	const commandId = options.commandId ?? nextMobileCommandId(options.kind);
	const connKey =
		options.connKey ?? connectionKeyForOptions(options.connection);
	const { environmentId, resource } = sessionCommandContext(
		connKey,
		options.connection,
		options.sessionId,
	);
	const payload =
		typeof options.payload === "object" && options.payload !== null
			? { ...options.payload, commandId }
			: options.payload;
	const receipt = await dispatchMobileSessionCommand<Result>({
		kind: options.kind,
		commandId,
		environmentId,
		resource,
		payload,
		retry: "safe",
		createdAt: Date.now(),
	});
	return receipt.result;
};

const terminalCommand = <Result>(options: {
	readonly ref: TerminalRef;
	readonly kind: "pty.write" | "pty.resize" | "pty.close";
	readonly payload: unknown;
}): Promise<CommandReceipt<Result>> =>
	dispatchMobileSessionCommand({
		kind: options.kind,
		commandId: CommandId.make(crypto.randomUUID()),
		environmentId: options.ref.environmentId,
		resource: terminalResourceKey(options.ref),
		payload: options.payload,
		retry: "never",
		createdAt: Date.now(),
	});

export const retainMobileTerminalResource = (options: {
	readonly connKey: string;
	readonly connection: WsProtocolOptions;
	readonly terminalId: PtyId;
	readonly ownerId: string;
	readonly sink: TerminalOutputSink;
}) => {
	const environmentId = registerMobileEnvironment(
		options.connKey,
		options.connection,
	);
	const ref = {
		environmentId,
		terminalId: options.terminalId,
	} satisfies TerminalRef;
	const key = terminalResourceKey(ref);
	const id = resourceKeyId(key);
	const existing = terminalSinks.get(id);
	if (
		existing !== undefined &&
		(existing.sink !== options.sink || existing.ownerId !== options.ownerId)
	) {
		throw new Error(`Terminal sink already retained: ${id}`);
	}
	if (existing === undefined) {
		terminalSinks.set(id, {
			ownerId: options.ownerId,
			sink: options.sink,
			retainers: 1,
		});
	} else {
		existing.retainers += 1;
	}
	const lease = mobileClientBus().retain(key, { activation: "connect" });
	let released = false;
	return {
		ref,
		key,
		lease: {
			activate: lease.activate,
			release: () => {
				if (released) return;
				released = true;
				lease.release();
				const retained = terminalSinks.get(id);
				if (retained?.sink !== options.sink) return;
				retained.retainers -= 1;
				if (retained.retainers === 0) {
					terminalSinks.delete(id);
					mobileClientBus().forget(key);
				}
			},
		},
	};
};

export const dispatchMobileTerminalInput = (
	ref: TerminalRef,
	ownerId: string,
	data: string,
): Promise<void> =>
	terminalCommand<void>({
		ref,
		kind: "pty.write",
		payload: { ptyId: ref.terminalId, ownerId, data },
	}).then(() => undefined);

export const dispatchMobileTerminalResize = (
	ref: TerminalRef,
	ownerId: string,
	cols: number,
	rows: number,
): Promise<void> =>
	terminalCommand<void>({
		ref,
		kind: "pty.resize",
		payload: { ptyId: ref.terminalId, ownerId, cols, rows },
	}).then(() => undefined);

export const dispatchMobileTerminalClose = (
	ref: TerminalRef,
	ownerId: string,
): Promise<void> =>
	terminalCommand<void>({
		ref,
		kind: "pty.close",
		payload: { ptyId: ref.terminalId, ownerId },
	}).then(() => undefined);

export const resetMobileClientBus = async (): Promise<void> => {
	const previous = bus;
	bindings.clear();
	terminalSinks.clear();
	messagePager.clear();
	await previous.dispose();
	await commandOutbox.close();
	commandOutbox = new MobileCommandOutbox();
	bus = makeBus();
};
