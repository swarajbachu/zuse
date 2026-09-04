import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import type {
	CommandAcceptance,
	CommandId,
	CommandStatus,
	EnvironmentId,
} from "@zuse/contracts";

import { type ResourceKey, resourceKeyId } from "./resource-ref";
import type { ResourceCursor } from "./resource-state";

export type PersistedResource<Data> = Readonly<{
	data: Data;
	cursor: ResourceCursor | null;
	storedAt: number;
}>;

export interface ResourcePersistence {
	readonly loadResource: <Data>(
		key: ResourceKey<Data>,
	) => Promise<PersistedResource<Data> | null>;
	readonly saveResource: <Data>(
		key: ResourceKey<Data>,
		value: PersistedResource<Data>,
	) => Promise<void>;
	readonly removeResource: (key: ResourceKey<unknown>) => Promise<void>;
}

export type CommandRetryPolicy = "safe" | "never";

export type ClientCommand<Payload = unknown, Result = unknown> = Readonly<{
	/** Stable renderer command kind understood by the platform executor. */
	kind: string;
	commandId: CommandId;
	environmentId: EnvironmentId;
	resource: ResourceKey<unknown> | null;
	payload: Payload;
	retry: CommandRetryPolicy;
	createdAt: number;
	/**
	 * Keep optimistic command state until the authoritative resource projection
	 * contains the applied effect. This closes the receipt-before-stream gap for
	 * turn starts without delaying mailbox acceptance.
	 */
	awaitResourceReflection?: boolean;
	/** ClientBus-owned durable fence captured before command dispatch. */
	resourceReflection?: Readonly<{ cursor: ResourceCursor | null }>;
	/** Carries the expected receipt type without adding wire data. */
	readonly __result?: Result;
}>;

export type CommandFingerprint = `sha256:${string}`;

/** Receipt returned by the platform executor before ClientBus binds identity. */
export type CommandExecutionReceipt<Result = unknown> = Readonly<{
	commandId: CommandId;
	receivedAt: number;
	result: Result;
}>;

export type CommandReceipt<Result = unknown> = Readonly<{
	commandId: CommandId;
	/** Hash of kind, environment, qualified resource, retry policy, and payload. */
	fingerprint: CommandFingerprint;
	receivedAt: number;
	result: Result;
	/**
	 * An authoritative terminal mailbox outcome. When present, `result` is only a
	 * backwards-compatible storage slot and must never be returned to callers.
	 */
	terminalError?: Readonly<{
		state: CommandStatus["state"];
		category?: string;
		message: string;
	}>;
}>;

export type OutboxEntry = Readonly<{
	command: ClientCommand;
	fingerprint: CommandFingerprint;
	/** Opaque encrypted v3 envelope; persisted before network acceptance. */
	encryptedEnvelope?: unknown;
	acceptance?: CommandAcceptance;
	deliveryStatus?: CommandStatus;
	attempts: number;
	lastAttemptAt: number | null;
}>;

export class CommandIdentityCollisionError extends Error {
	override readonly name = "CommandIdentityCollisionError";

	constructor(
		readonly commandId: CommandId,
		readonly storedFingerprint: string,
		readonly requestedFingerprint: string,
	) {
		super(`Command ID ${commandId} was reused for a different command`);
	}
}

export const canonicalClientCommandJson = (value: unknown): string => {
	const ancestors = new Set<object>();
	const encode = (
		input: unknown,
		arrayElement: boolean,
	): string | undefined => {
		if (input === null) return "null";
		switch (typeof input) {
			case "string":
				return JSON.stringify(input);
			case "boolean":
				return input ? "true" : "false";
			case "number":
				return Number.isFinite(input) ? JSON.stringify(input) : "null";
			case "undefined":
			case "function":
			case "symbol":
				return arrayElement ? "null" : undefined;
			case "bigint":
				throw new TypeError(
					"Client command payloads cannot contain bigint values",
				);
			case "object": {
				if (ancestors.has(input)) {
					throw new TypeError("Client command payloads cannot contain cycles");
				}
				// Binary RPC payloads (most notably attachment uploads) arrive here as
				// Uint8Array instances. Object.keys() exposes one property per byte, so
				// treating them as ordinary records creates an enormous intermediate JSON
				// string before the command can even reach the transport. Hash the bytes
				// directly so even the maximum-size attachment contributes a fixed-size
				// value, and tag it so it cannot collide with an ordinary numeric-keyed
				// object. The outer command fingerprint remains a SHA-256 identity.
				if (input instanceof Uint8Array) {
					return `Uint8Array(sha256:${bytesToHex(sha256(input))})`;
				}
				ancestors.add(input);
				try {
					const toJson = Reflect.get(input, "toJSON");
					if (typeof toJson === "function") {
						return encode(Reflect.apply(toJson, input, []), arrayElement);
					}
					if (Array.isArray(input)) {
						return `[${Array.from(
							{ length: input.length },
							(_, index) => encode(input[index], true) ?? "null",
						).join(",")}]`;
					}
					const properties: string[] = [];
					for (const key of Object.keys(input).sort()) {
						const encoded = encode(Reflect.get(input, key), false);
						if (encoded !== undefined) {
							properties.push(`${JSON.stringify(key)}:${encoded}`);
						}
					}
					return `{${properties.join(",")}}`;
				} finally {
					ancestors.delete(input);
				}
			}
		}
	};
	return encode(value, false) ?? "null";
};

/**
 * Deterministic identity for retries. `createdAt` is intentionally excluded:
 * it is local scheduling metadata, while every execution-relevant field is
 * included. Canonical JSON mirrors persisted/wire JSON semantics and sorts
 * object keys, so equivalent decoded payloads retain the same identity.
 */
export const commandFingerprint = (
	command: ClientCommand,
): CommandFingerprint => {
	const identity = canonicalClientCommandJson([
		"zuse-client-command-v1",
		command.kind,
		command.environmentId,
		command.resource === null ? null : resourceKeyId(command.resource),
		command.retry,
		command.payload,
	]);
	return `sha256:${bytesToHex(sha256(identity))}`;
};

export const assertCommandFingerprint = (
	commandId: CommandId,
	storedFingerprint: string,
	requestedFingerprint: string,
): void => {
	if (storedFingerprint === requestedFingerprint) return;
	throw new CommandIdentityCollisionError(
		commandId,
		storedFingerprint,
		requestedFingerprint,
	);
};

export interface CommandOutbox {
	readonly putOutbox: (entry: OutboxEntry) => Promise<void>;
	readonly removeOutbox: (
		commandId: CommandId,
		fingerprint: CommandFingerprint,
	) => Promise<void>;
	/** Persist the receipt and remove the matching outbox row atomically. */
	readonly completeOutbox: (receipt: CommandReceipt) => Promise<void>;
	readonly findReceipt: (
		commandId: CommandId,
	) => Promise<CommandReceipt | null>;
	readonly putReceipt?: (receipt: CommandReceipt) => Promise<void>;
	readonly listOutbox: (
		environmentId?: EnvironmentId,
	) => Promise<readonly OutboxEntry[]>;
}

export interface ClientPersistence extends ResourcePersistence, CommandOutbox {}

export interface ClientCommandExecutor<Client> {
	readonly execute: (
		client: Client,
		command: ClientCommand,
	) => Promise<CommandExecutionReceipt>;
}

export type CommandDispatchHandle<Result = unknown> = Readonly<{
	accepted: Promise<CommandAcceptance>;
	result: Promise<CommandReceipt<Result>>;
	cancel: () => Promise<CommandStatus>;
	/** Present for opaque mailbox transports so IndexedDB can restore delivery. */
	encryptedEnvelope?: Promise<unknown>;
	subscribeStatus?: (listener: (status: CommandStatus) => void) => () => void;
}>;

/**
 * A cloud delivery is prepared before it is started so the encrypted envelope
 * can reach local durable storage before the first enqueue request leaves the
 * client. This ordering closes the crash window between encryption and mailbox
 * acceptance without exposing the start gate to renderer call sites.
 */
export type PreparedCloudCommandHandle<Result = unknown> =
	CommandDispatchHandle<Result> &
		Readonly<{
			encryptedEnvelope: Promise<unknown>;
			/** Keyed identity that binds persisted delivery states to this envelope. */
			deliveryFingerprint: Promise<string>;
			start: () => void;
			/** Stop this in-memory attempt without removing its durable outbox row. */
			dispose: () => void;
		}>;

export interface CloudCommandTransport {
	/** Whether this exact payload is implemented by the current rollout slice. */
	readonly supports: (command: ClientCommand) => boolean;
	readonly dispatch: <Result>(input: {
		readonly command: ClientCommand<unknown, Result>;
		readonly fingerprint: CommandFingerprint;
	}) => PreparedCloudCommandHandle<Result>;
	/**
	 * Reuse an opaque envelope already persisted by the client. With an
	 * acceptance this only resumes observation; without one it idempotently
	 * retries enqueueing those exact bytes.
	 */
	readonly resume: <Result>(input: {
		readonly command: ClientCommand<unknown, Result>;
		readonly fingerprint: CommandFingerprint;
		readonly encryptedEnvelope: unknown;
		readonly acceptance?: CommandAcceptance;
		readonly deliveryStatus?: CommandStatus;
	}) => PreparedCloudCommandHandle<Result>;
}

export class CloudCommandTransportUnavailableError extends Error {
	override readonly name = "CloudCommandTransportUnavailableError";
}

export class CloudCommandTerminalError extends Error {
	override readonly name = "CloudCommandTerminalError";

	constructor(
		readonly state: CommandStatus["state"],
		readonly category: string | undefined,
		message: string,
		readonly occurredAt?: number,
	) {
		super(message);
	}
}

/** Encode a typed terminal failure in the same durable receipt log as success. */
export const terminalCommandReceipt = (
	commandId: CommandId,
	fingerprint: CommandFingerprint,
	error: CloudCommandTerminalError,
): CommandReceipt<undefined> => ({
	commandId,
	fingerprint,
	receivedAt: error.occurredAt ?? Date.now(),
	result: undefined,
	terminalError: {
		state: error.state,
		...(error.category === undefined ? {} : { category: error.category }),
		message: error.message,
	},
});

/** Reconstruct the public typed failure from a persisted terminal receipt. */
export const terminalErrorFromReceipt = (
	receipt: CommandReceipt | null | undefined,
): CloudCommandTerminalError | null => {
	if (receipt === null || receipt === undefined) return null;
	const terminal = receipt.terminalError;
	return terminal === undefined
		? null
		: new CloudCommandTerminalError(
				terminal.state,
				terminal.category,
				terminal.message,
				receipt.receivedAt,
			);
};
