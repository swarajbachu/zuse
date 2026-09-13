import type {
	CloudCommandTransport,
	CommandFingerprint,
	PreparedCloudCommandHandle,
} from "@zuse/client-runtime/client-persistence";
import {
	type ClientCommand,
	CloudCommandTerminalError,
	CloudCommandTransportUnavailableError,
	canonicalClientCommandJson,
} from "@zuse/client-runtime/client-persistence";
import {
	type CloudCommandEligibility,
	cloudCommandEligibility,
	cloudMessageSendPayloadLimitation,
	decodeCloudCommandResult,
	decodeCloudMessageSendPayload,
} from "@zuse/cloud-commands";
import {
	CloudCommandEnvelope,
	CommandAcceptance,
	CommandStatus,
	isCloudCommandFailureState,
	isCloudCommandTerminalState,
	SessionId,
} from "@zuse/contracts";
import {
	cloudCommandAdditionalData,
	decryptCloudCommandBody,
	encryptCloudCommandBody,
	keyedCloudCommandFingerprint,
} from "@zuse/utils/cloud-command-crypto";
import { Effect, Schema } from "effect";
import type { CloudCommandControlClient } from "./cloud-control-client.ts";
import { cloudFailurePresentation } from "./cloud-failure-presentation.ts";

export const makeCloudCommandTransport = (
	getControlPlaneRpcClient: () => Promise<CloudCommandControlClient>,
): CloudCommandTransport => {
	const sessionIdOf = (command: ClientCommand): string => {
		const payload = command.payload as Readonly<Record<string, unknown>>;
		if (typeof payload.sessionId === "string") return payload.sessionId;
		if (command.resource !== null && "sessionId" in command.resource.ref)
			return command.resource.ref.sessionId;
		throw new Error("Durable cloud commands require an explicit session");
	};

	const terminalError = (status: CommandStatus): CloudCommandTerminalError => {
		const presentation = cloudFailurePresentation({
			state: status.state,
			category: status.category,
		});
		const label =
			presentation?.message ?? "The agent could not complete this command.";
		return new CloudCommandTerminalError(
			status.state,
			status.category,
			label,
			status.updatedAt,
		);
	};

	const errorCode = (cause: unknown): unknown =>
		typeof cause === "object" && cause !== null
			? Reflect.get(cause, "code")
			: undefined;

	type ControlPlaneFailure =
		| Readonly<{ kind: "transient" }>
		| Readonly<{
				kind: "blocked";
				blockedUntil: NonNullable<CommandStatus["blockedUntil"]>;
				category: string;
		  }>
		| Readonly<{
				kind: "terminal";
				error: CloudCommandTerminalError;
		  }>;

	const blockedFailure = (
		blockedUntil: NonNullable<CommandStatus["blockedUntil"]>,
		category: string,
	): ControlPlaneFailure => ({ kind: "blocked", blockedUntil, category });

	const staticControlPlaneFailure = (
		cause: unknown,
	): ControlPlaneFailure | null => {
		if (cause instanceof CloudCommandTerminalError)
			return { kind: "terminal", error: cause };
		if (cause instanceof CloudCommandTransportUnavailableError)
			return blockedFailure("runtime-compatible", "update-required");
		const presentation = cloudFailurePresentation({ cause });
		if (presentation?.kind === "sign-in-required")
			return blockedFailure("auth-restored", presentation.kind);
		if (presentation?.kind === "billing-blocked")
			return blockedFailure("billing-restored", presentation.kind);
		if (presentation?.kind === "update-required")
			return blockedFailure("runtime-compatible", presentation.kind);
		if (
			presentation?.kind === "cloud-access-required" ||
			presentation?.kind === "cloud-access-unavailable" ||
			presentation?.kind === "credentials-required"
		)
			return blockedFailure(
				"manual-retry",
				presentation.kind === "credentials-required"
					? "credential-required"
					: presentation.kind === "cloud-access-required"
						? "beta-access-required"
						: "beta-access-unavailable",
			);
		return null;
	};

	const destructiveWorkspaceLifecycle = (workspace: {
		readonly state: string;
		readonly desiredState: string;
	}): boolean =>
		workspace.state === "archiving" ||
		workspace.state === "archived" ||
		workspace.state === "deleting" ||
		workspace.state === "deleted" ||
		workspace.desiredState === "archived" ||
		workspace.desiredState === "deleted";

	const workspaceUnavailable = (): CloudCommandTerminalError =>
		new CloudCommandTerminalError(
			"cancelled",
			"workspace-deleted",
			"This workspace was archived or deleted before the command could finish.",
		);

	const classifyControlPlaneFailure = async (
		workspaceId: string,
		cause: unknown,
	): Promise<ControlPlaneFailure> => {
		const classified = staticControlPlaneFailure(cause);
		if (classified !== null) return classified;
		const code = errorCode(cause);
		if (code !== "not-found" && code !== "conflict")
			return { kind: "transient" };
		try {
			const control = await getControlPlaneRpcClient();
			const workspace = await Effect.runPromise(
				control["cloud.workspaces.get"]({ workspaceId }),
			);
			if (destructiveWorkspaceLifecycle(workspace))
				return { kind: "terminal", error: workspaceUnavailable() };
			// An accepted v3 command on a reachable workspace cannot safely fall back to
			// live RPC. A missing/conflicting mailbox route means the control plane must
			// regain drain compatibility before delivery can continue.
			return blockedFailure("runtime-compatible", "update-required");
		} catch (workspaceCause) {
			const workspaceFailure = staticControlPlaneFailure(workspaceCause);
			if (workspaceFailure !== null) return workspaceFailure;
			if (errorCode(workspaceCause) === "not-found")
				return { kind: "terminal", error: workspaceUnavailable() };
			return { kind: "transient" };
		}
	};

	const dataKey = async (workspaceId: string) => {
		const control = await getControlPlaneRpcClient();
		try {
			return await Effect.runPromise(
				control["cloud.commands.dataKey"]({ workspaceId }),
			);
		} catch (cause) {
			const code = errorCode(cause);
			if (code !== "not-found" && code !== "conflict") throw cause;

			// During the additive v3 rollout, an older control plane returns the same
			// endpoint-level 404 as a genuinely missing workspace. Disambiguate through
			// the long-lived v2 workspace route before assigning a terminal lifecycle.
			// The data-key route also fences deleting/deleted workspaces with a conflict,
			// which must resolve to the same typed terminal state instead of entering the
			// live fallback or retry path.
			try {
				const workspace = await Effect.runPromise(
					control["cloud.workspaces.get"]({ workspaceId }),
				);
				if (destructiveWorkspaceLifecycle(workspace))
					throw workspaceUnavailable();
				if (code === "not-found")
					throw new CloudCommandTransportUnavailableError(
						"Durable cloud commands are not available on this control plane",
					);
				throw cause;
			} catch (workspaceCause) {
				if (
					workspaceCause instanceof CloudCommandTerminalError ||
					workspaceCause instanceof CloudCommandTransportUnavailableError
				)
					throw workspaceCause;
				if (errorCode(workspaceCause) === "not-found")
					throw workspaceUnavailable();
				throw workspaceCause;
			}
		}
	};

	const commandStatus = async (workspaceId: string, commandId: string) => {
		const control = await getControlPlaneRpcClient();
		return Effect.runPromise(
			control["cloud.commands.status"]({ workspaceId, commandId }),
		);
	};

	const sleep = (durationMs: number): Promise<void> =>
		new Promise((resolve) => setTimeout(resolve, durationMs));

	const attemptDisposedError = (): Error =>
		new Error("Cloud command attempt disposed");

	const attemptAbortCause = (signal: AbortSignal): unknown =>
		signal.reason ?? attemptDisposedError();

	const untilAttemptDisposed = <Value>(
		promise: Promise<Value>,
		signal: AbortSignal,
	): Promise<Value> => {
		if (signal.aborted) return Promise.reject(attemptAbortCause(signal));
		return new Promise<Value>((resolve, reject) => {
			const onAbort = () => {
				signal.removeEventListener("abort", onAbort);
				reject(attemptAbortCause(signal));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			void promise.then(
				(value) => {
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(cause) => {
					signal.removeEventListener("abort", onAbort);
					reject(cause);
				},
			);
		});
	};

	const attemptLifetime = () => {
		const controller = new AbortController();
		return {
			signal: controller.signal,
			dispose: () => {
				if (!controller.signal.aborted)
					controller.abort(attemptDisposedError());
			},
		};
	};

	type StatusSubscriber = Readonly<{
		commandId: string;
		observe: (status: CommandStatus) => void;
		onFailure: (failure: ControlPlaneFailure) => void;
	}>;

	/**
	 * One cursor and long-poll loop per workspace. Individual command handles only
	 * register filtered observers, so many queued commands still use one watch.
	 */
	class WorkspaceStatusFanout {
		private readonly subscribers = new Set<StatusSubscriber>();
		private revision: number | null = null;
		private running = false;

		constructor(
			private readonly workspaceId: string,
			private readonly onIdle: () => void,
		) {}

		subscribe(
			commandId: string,
			afterRevision: number,
			observe: (status: CommandStatus) => void,
			onFailure: (failure: ControlPlaneFailure) => void,
		): () => void {
			const subscriber = { commandId, observe, onFailure };
			this.subscribers.add(subscriber);
			if (this.revision === null) this.revision = Math.max(0, afterRevision);
			this.start();
			return () => {
				this.subscribers.delete(subscriber);
			};
		}

		private start(): void {
			if (this.running) return;
			this.running = true;
			void this.run().finally(() => {
				this.running = false;
				if (this.subscribers.size === 0) this.onIdle();
				else this.start();
			});
		}

		private publish(status: CommandStatus): void {
			for (const subscriber of this.subscribers) {
				if (subscriber.commandId === status.commandId)
					subscriber.observe(status);
			}
		}

		private async refreshAll(): Promise<void> {
			const commandIds = [
				...new Set(
					[...this.subscribers].map((subscriber) => subscriber.commandId),
				),
			];
			const statuses = await Promise.all(
				commandIds.map((commandId) =>
					commandStatus(this.workspaceId, commandId),
				),
			);
			for (const status of statuses) this.publish(status);
		}

		private async run(): Promise<void> {
			let retryDelayMs = 100;
			while (this.subscribers.size > 0) {
				const afterRevision = this.revision ?? 0;
				try {
					const control = await getControlPlaneRpcClient();
					const page = await Effect.runPromise(
						control["cloud.commands.watch"]({
							workspaceId: this.workspaceId,
							afterRevision,
						}),
					);
					if (page.resetRequired) {
						// A reset says earlier history was compacted. Refresh every accepted
						// command authoritatively before moving the shared cursor forward.
						await this.refreshAll();
					} else {
						for (const status of page.changes) this.publish(status);
					}
					this.revision = Math.max(afterRevision, page.nextRevision);
					retryDelayMs = 100;
				} catch (cause) {
					const failure = await classifyControlPlaneFailure(
						this.workspaceId,
						cause,
					);
					for (const subscriber of [...this.subscribers])
						subscriber.onFailure(failure);
					if (this.subscribers.size === 0) return;
					await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
					retryDelayMs = Math.min(retryDelayMs * 2, 2_000);
				}
			}
		}
	}

	const workspaceFanouts = new Map<string, WorkspaceStatusFanout>();

	const workspaceFanout = (workspaceId: string): WorkspaceStatusFanout => {
		const fanout = workspaceFanouts.get(workspaceId);
		if (fanout !== undefined) return fanout;
		const created = new WorkspaceStatusFanout(workspaceId, () => {
			if (workspaceFanouts.get(workspaceId) === created)
				workspaceFanouts.delete(workspaceId);
		});
		workspaceFanouts.set(workspaceId, created);
		return created;
	};

	/** A v3 status is authoritative only for the exact keyed envelope on disk. */
	const assertStatusEnvelopeIdentity = (
		status: CommandStatus,
		envelope: CloudCommandEnvelope,
	): void => {
		if (
			status.commandId === envelope.commandId &&
			status.fingerprint === envelope.fingerprint
		)
			return;
		if (status.fingerprint === undefined)
			throw new CloudCommandTerminalError(
				"outcome-unknown",
				"command-identity-unverified",
				"The command status could not be bound to its encrypted recovery record.",
				status.updatedAt,
			);
		throw new CloudCommandTerminalError(
			"rejected",
			"command-identity-collision",
			"This command ID is already bound to different content.",
			status.updatedAt,
		);
	};

	const acceptanceFromStatus = (
		status: CommandStatus,
		envelope: CloudCommandEnvelope,
	): CommandAcceptance | null => {
		assertStatusEnvelopeIdentity(status, envelope);
		if (isCloudCommandFailureState(status.state)) throw terminalError(status);
		if (
			status.state === "reserved" ||
			status.state === "leased" ||
			status.state === "lease-expired-awaiting-fence"
		)
			return null;
		return {
			commandId: status.commandId,
			workspaceSequence: status.workspaceSequence,
			revision: status.revision,
			acceptedAt: status.updatedAt,
			// Applied is the sole terminal state which proves successful acceptance;
			// result recovery still observes the applied row and decrypts its receipt.
			state: status.state === "applied" ? "accepted" : status.state,
		} as CommandAcceptance;
	};

	const startGate = () => {
		let resolve!: () => void;
		const promise = new Promise<void>((onResolve) => {
			resolve = onResolve;
		});
		let started = false;
		return {
			promise,
			start: () => {
				if (started) return;
				started = true;
				resolve();
			},
		};
	};

	type EligibleCloudCommand = Readonly<{
		eligibility: CloudCommandEligibility;
		plaintext: Uint8Array;
	}>;

	const eligibleCloudCommand = (
		command: ClientCommand,
	): EligibleCloudCommand | null => {
		const eligibility = cloudCommandEligibility(command.kind);
		if (command.kind !== "messages.send" || eligibility === undefined)
			return null;
		const payload = decodeCloudMessageSendPayload(command.payload);
		if (
			payload === null ||
			payload.commandId !== command.commandId ||
			payload.sessionId !== sessionIdOf(command) ||
			cloudMessageSendPayloadLimitation(payload) !== null
		)
			return null;
		try {
			const plaintext = new TextEncoder().encode(
				canonicalClientCommandJson(payload),
			);
			return plaintext.byteLength <= eligibility.maxPlaintextBytes
				? { eligibility, plaintext }
				: null;
		} catch {
			return null;
		}
	};

	const supportsCommand = (command: ClientCommand): boolean =>
		eligibleCloudCommand(command) !== null;

	const decodePersistedEnvelope = (
		value: unknown,
		command: ClientCommand,
	): CloudCommandEnvelope => {
		let envelope: CloudCommandEnvelope;
		try {
			envelope = Schema.decodeUnknownSync(CloudCommandEnvelope)(value);
		} catch {
			throw new CloudCommandTerminalError(
				"outcome-unknown",
				"invalid-local-envelope",
				"The accepted command's encrypted local recovery record is invalid.",
			);
		}
		if (
			envelope.workspaceId !== String(command.environmentId) ||
			envelope.sessionId !== sessionIdOf(command) ||
			envelope.commandId !== command.commandId ||
			envelope.kind !== command.kind
		)
			throw new CloudCommandTerminalError(
				"outcome-unknown",
				"invalid-local-envelope",
				"The accepted command's encrypted local recovery record does not match the command.",
			);
		return envelope;
	};

	const resultFor = <Result>(input: {
		command: ClientCommand<unknown, Result>;
		fingerprint: CommandFingerprint;
		envelope: Promise<CloudCommandEnvelope>;
		encodedKey: () => Promise<string>;
		accepted: Promise<CommandAcceptance>;
		signal: AbortSignal;
		initialStatus?: CommandStatus;
		publishStatus: (status: CommandStatus) => void;
	}) =>
		input.accepted.then(async (acceptance) => {
			const envelope = await input.envelope;
			const resolveTerminal = async (status: CommandStatus) => {
				if (status.state !== "applied") throw terminalError(status);
				if (
					status.resultIv === undefined ||
					status.resultCiphertext === undefined
				)
					throw new CloudCommandTerminalError(
						status.state,
						"result-expired",
						"The command was applied, but its result has expired.",
						status.updatedAt,
					);
				let encodedKey: string;
				try {
					encodedKey = await input.encodedKey();
				} catch (cause) {
					const failure = await classifyControlPlaneFailure(
						envelope.workspaceId,
						cause,
					);
					if (failure.kind === "terminal") throw failure.error;
					// Key access can recover after sign-in, billing, rollout, or a transient
					// network failure. Keep the accepted outbox row for the next resume.
					throw cause;
				}
				let result: Result;
				try {
					const plaintext = await decryptCloudCommandBody({
						encodedKey,
						additionalData: cloudCommandAdditionalData(envelope),
						iv: status.resultIv,
						ciphertext: status.resultCiphertext,
					});
					const decoded = JSON.parse(
						new TextDecoder().decode(plaintext),
					) as unknown;
					const eligibility = cloudCommandEligibility(envelope.kind);
					const terminalResult =
						eligibility === undefined
							? null
							: decodeCloudCommandResult(eligibility, decoded);
					if (
						terminalResult === null ||
						terminalResult.commandId !== envelope.commandId
					)
						throw new Error("invalid cloud command result");
					result = terminalResult.result as Result;
				} catch {
					// A terminal mailbox row will return the same opaque bytes forever. Treat
					// an unreadable result as authoritative instead of leaving the accepted
					// IndexedDB row in an infinite retry loop.
					throw new CloudCommandTerminalError(
						"outcome-unknown",
						"result-invalid",
						"The command was applied, but its encrypted result could not be recovered.",
						status.updatedAt,
					);
				}
				return {
					commandId: input.command.commandId,
					fingerprint: input.fingerprint,
					receivedAt: status.updatedAt,
					result,
				};
			};

			return new Promise<Awaited<ReturnType<typeof resolveTerminal>>>(
				(resolve, reject) => {
					let latestRevision = -1;
					let latestStatus = input.initialStatus;
					let settled = false;
					let unsubscribe: () => void = () => undefined;
					const cleanup = () => {
						input.signal.removeEventListener("abort", onAbort);
						unsubscribe();
					};
					const onAbort = () => {
						if (settled) return;
						settled = true;
						cleanup();
						reject(attemptAbortCause(input.signal));
					};
					const observe = (status: CommandStatus) => {
						if (settled || status.revision < latestRevision) return;
						try {
							assertStatusEnvelopeIdentity(status, envelope);
						} catch (cause) {
							settled = true;
							cleanup();
							reject(cause);
							return;
						}
						latestRevision = status.revision;
						latestStatus = status;
						input.publishStatus(status);
						if (!isCloudCommandTerminalState(status.state)) return;
						settled = true;
						cleanup();
						void resolveTerminal(status).then(resolve, reject);
					};
					const observeFailure = (failure: ControlPlaneFailure): void => {
						if (settled || failure.kind === "transient") return;
						if (failure.kind === "terminal") {
							settled = true;
							cleanup();
							reject(failure.error);
							return;
						}
						const base = latestStatus;
						observe(
							CommandStatus.make({
								commandId: input.command.commandId,
								workspaceSequence:
									base?.workspaceSequence ?? acceptance.workspaceSequence,
								revision: Math.max(base?.revision ?? 0, acceptance.revision),
								fingerprint: envelope.fingerprint,
								state: "blocked",
								everLeased: base?.everLeased ?? false,
								updatedAt: Date.now(),
								category: failure.category,
								blockedUntil: failure.blockedUntil,
							}),
						);
					};
					input.signal.addEventListener("abort", onAbort, { once: true });
					if (input.signal.aborted) {
						onAbort();
						return;
					}
					unsubscribe = workspaceFanout(envelope.workspaceId).subscribe(
						input.command.commandId,
						Math.max(acceptance.revision, input.initialStatus?.revision ?? 0),
						observe,
						observeFailure,
					);
					if (settled) {
						unsubscribe();
						return;
					}
					if (input.initialStatus !== undefined) observe(input.initialStatus);
					// Register with the shared cursor first; this read then closes the race
					// between acceptance/restart and the first long-poll response.
					void (async () => {
						let retryDelayMs = 100;
						while (!settled) {
							try {
								observe(
									await commandStatus(
										envelope.workspaceId,
										input.command.commandId,
									),
								);
								return;
							} catch (cause) {
								if (settled) return;
								observeFailure(
									await classifyControlPlaneFailure(
										envelope.workspaceId,
										cause,
									),
								);
								if (settled) return;
								await sleep(retryDelayMs);
								retryDelayMs = Math.min(retryDelayMs * 2, 2_000);
							}
						}
					})();
				},
			);
		});

	const statusPublisher = () => {
		const listeners = new Set<(status: CommandStatus) => void>();
		let latest: CommandStatus | null = null;
		return {
			publish: (status: CommandStatus) => {
				if (latest !== null && status.revision < latest.revision) return;
				latest = status;
				for (const listener of listeners) listener(status);
			},
			subscribe: (listener: (status: CommandStatus) => void) => {
				listeners.add(listener);
				if (latest !== null) listener(latest);
				return () => listeners.delete(listener);
			},
		};
	};

	/**
	 * Idempotently accepts one already-encrypted identity. Response-loss recovery
	 * is deliberately expressed in terms of the envelope, never the mutable
	 * caller command, so every retry addresses the same mailbox row.
	 */
	const enqueueEnvelope = async (
		envelope: CloudCommandEnvelope,
	): Promise<CommandAcceptance> => {
		try {
			const control = await getControlPlaneRpcClient();
			return await Effect.runPromise(
				control["cloud.commands.enqueue"](envelope),
			);
		} catch (enqueueCause) {
			// The response may have been lost after insertion. An authoritative
			// identity-bound status converts that ambiguity back into acceptance.
			let statusMissing = false;
			try {
				const status = await commandStatus(
					envelope.workspaceId,
					envelope.commandId,
				);
				const recovered = acceptanceFromStatus(status, envelope);
				if (recovered !== null) return recovered;
			} catch (statusCause) {
				if (statusCause instanceof CloudCommandTerminalError) throw statusCause;
				const failure = await classifyControlPlaneFailure(
					envelope.workspaceId,
					statusCause,
				);
				if (failure.kind === "terminal") throw failure.error;
				statusMissing = errorCode(statusCause) === "not-found";
				// Preserve the enqueue failure; ClientBus retains this exact envelope.
			}
			if (errorCode(enqueueCause) === "conflict" && statusMissing) {
				// A retained runtime can lose eligibility between initial key read and
				// enqueue. Only explicit disabled capability permits one live fallback;
				// lifecycle/fence conflicts remain authoritative failures.
				try {
					const refreshed = await dataKey(envelope.workspaceId);
					if (!refreshed.mailboxEnabled)
						throw new CloudCommandTransportUnavailableError(
							"This workspace runtime requires the live command transport",
						);
				} catch (refreshCause) {
					if (
						refreshCause instanceof CloudCommandTransportUnavailableError ||
						refreshCause instanceof CloudCommandTerminalError
					)
						throw refreshCause;
				}
			}
			throw enqueueCause;
		}
	};

	const cancelEnvelope = async (
		envelope: CloudCommandEnvelope,
	): Promise<CommandStatus> => {
		const control = await getControlPlaneRpcClient();
		const status = await Effect.runPromise(
			control["cloud.commands.cancel"]({
				workspaceId: envelope.workspaceId,
				commandId: envelope.commandId,
			}),
		);
		assertStatusEnvelopeIdentity(status, envelope);
		return status;
	};

	/** Opaque control-plane transport; it never requests a compute connection. */
	const transport: CloudCommandTransport = {
		supports: supportsCommand,
		dispatch: <Result>({
			command,
			fingerprint,
		}: {
			command: ClientCommand<unknown, Result>;
			fingerprint: CommandFingerprint;
		}): PreparedCloudCommandHandle<Result> => {
			const publisher = statusPublisher();
			const lifetime = attemptLifetime();
			const gate = startGate();
			const prepared = untilAttemptDisposed(
				(async () => {
					const eligible = eligibleCloudCommand(command);
					if (eligible === null)
						throw new CloudCommandTransportUnavailableError(
							"This command payload is not enabled for durable delivery",
						);
					const workspaceId = String(command.environmentId);
					// Snapshot plaintext before the first await so caller-side mutation cannot
					// change the fingerprinted command while key retrieval is in flight.
					const plaintext = eligible.plaintext;
					const key = await dataKey(workspaceId);
					if (!key.mailboxEnabled)
						throw new CloudCommandTransportUnavailableError(
							"Durable cloud commands are not enabled for this deployment",
						);
					const keyedFingerprint = await keyedCloudCommandFingerprint({
						encodedKey: key.encodedKey,
						canonicalPlaintext: plaintext,
					});
					const metadata = {
						protocolVersion: 3 as const,
						workspaceId,
						sessionId: SessionId.make(sessionIdOf(command)),
						commandId: command.commandId,
						kind: command.kind,
						fingerprint: keyedFingerprint,
						schemaVersion: eligible.eligibility.schemaVersion,
						keyVersion: key.keyVersion,
						destructionFence: key.destructionFence,
						createdAt: command.createdAt,
						dependencies: [],
					};
					const encrypted = await encryptCloudCommandBody({
						encodedKey: key.encodedKey,
						additionalData: cloudCommandAdditionalData(metadata),
						plaintext,
					});
					return {
						envelope: CloudCommandEnvelope.make({ ...metadata, ...encrypted }),
						encodedKey: key.encodedKey,
					};
				})(),
				lifetime.signal,
			);
			const envelope = prepared.then((value) => value.envelope);
			const accepted = untilAttemptDisposed(
				Promise.all([envelope, gate.promise]).then(([value]) =>
					enqueueEnvelope(value),
				),
				lifetime.signal,
			);
			const result = untilAttemptDisposed(
				resultFor({
					command,
					fingerprint,
					envelope,
					encodedKey: async () => (await prepared).encodedKey,
					accepted,
					signal: lifetime.signal,
					publishStatus: publisher.publish,
				}),
				lifetime.signal,
			);
			return {
				accepted,
				result,
				encryptedEnvelope: envelope,
				deliveryFingerprint: envelope.then((value) => value.fingerprint),
				start: gate.start,
				dispose: lifetime.dispose,
				cancel: async () => cancelEnvelope(await envelope),
				subscribeStatus: publisher.subscribe,
			};
		},
		resume: <Result>({
			command,
			fingerprint,
			encryptedEnvelope,
			acceptance,
			deliveryStatus,
		}: {
			command: ClientCommand<unknown, Result>;
			fingerprint: CommandFingerprint;
			encryptedEnvelope: unknown;
			acceptance?: CommandAcceptance;
			deliveryStatus?: CommandStatus;
		}): PreparedCloudCommandHandle<Result> => {
			const publisher = statusPublisher();
			const lifetime = attemptLifetime();
			const gate = startGate();
			const envelope = untilAttemptDisposed(
				Promise.resolve().then(() =>
					decodePersistedEnvelope(encryptedEnvelope, command),
				),
				lifetime.signal,
			);
			const accepted = untilAttemptDisposed(
				Promise.all([envelope, gate.promise]).then(([value]) => {
					if (acceptance === undefined) return enqueueEnvelope(value);
					try {
						acceptance =
							Schema.decodeUnknownSync(CommandAcceptance)(acceptance);
					} catch {
						throw new CloudCommandTerminalError(
							"outcome-unknown",
							"invalid-local-acceptance",
							"The accepted command's local recovery record is invalid.",
						);
					}
					if (acceptance.commandId !== value.commandId)
						throw new CloudCommandTerminalError(
							"outcome-unknown",
							"invalid-local-acceptance",
							"The command acceptance does not match its encrypted recovery record.",
							acceptance.acceptedAt,
						);
					return acceptance;
				}),
				lifetime.signal,
			);
			const result = untilAttemptDisposed(
				resultFor({
					command,
					fingerprint,
					envelope,
					encodedKey: async () => {
						const key = await dataKey((await envelope).workspaceId);
						return key.encodedKey;
					},
					accepted,
					signal: lifetime.signal,
					...(deliveryStatus === undefined
						? {}
						: { initialStatus: deliveryStatus }),
					publishStatus: publisher.publish,
				}),
				lifetime.signal,
			);
			return {
				accepted,
				result,
				encryptedEnvelope: envelope,
				deliveryFingerprint: envelope.then((value) => value.fingerprint),
				start: gate.start,
				dispose: lifetime.dispose,
				cancel: async () => cancelEnvelope(await envelope),
				subscribeStatus: publisher.subscribe,
			};
		},
	};

	return transport;
};
