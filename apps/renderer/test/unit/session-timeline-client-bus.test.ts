import {
	type ClientCommand,
	commandFingerprint,
	type PersistedResource,
} from "@zuse/client-runtime/client-persistence";
import {
	makeResourceKey,
	resourceKeyId,
} from "@zuse/client-runtime/resource-ref";
import {
	AgentTurnId,
	CloudWorkspaceOpError,
	CommandAcceptance,
	CommandId,
	ComposerInput,
	EnvironmentId,
	Message,
	MessageId,
	PtyId,
	QueuedMessage,
	QueueState,
	SessionId,
	SessionNotFoundError,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { Effect, Queue, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientCommandOutbox } from "../../src/lib/client-command-outbox.ts";
import { cloudCommandTransport } from "../../src/lib/cloud-command-transport.ts";
import { sessionMessageCommandReflected } from "../../src/lib/session-message-intent.ts";
import {
	addOptimisticSessionMessage,
	completeOlderSessionMessages,
	getRendererClientBus,
	loadOlderSessionMessages,
	registerEnvironmentActivationForTest,
	registerRendererResourceDriver,
	registerRendererResourcePersistence,
	registerSessionTimelineCheckpointSynchronizer,
	registerSessionTimelineOlderPageSynchronizer,
	rehydrateRendererCommandPayload,
	resetSessionTimelineClientBus,
	resetSessionTimelineClientBusForTest,
	restartProvisionalSessionTimeline,
	retainSessionTimeline,
	sessionTimelineResourceKey,
	setSessionTimelineRpcClientForTest,
	setSessionTimelineRpcSessionForTest,
	updateOptimisticSessionQueue,
} from "../../src/lib/session-timeline-client-bus.ts";

const waitUntil = async (predicate: () => boolean): Promise<void> => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not reached");
};

const environmentId = EnvironmentId.make("timeline-environment");
const sessionId = SessionId.make("timeline-session");
const ref = { environmentId, sessionId } as const;

describe("renderer session timeline ClientBus adapter", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		resetSessionTimelineClientBusForTest();
	});

	it("rehydrates composer classes after durable outbox structured cloning", () => {
		const plainInput = {
			text: "hi",
			attachments: [],
			fileRefs: [],
			skillRefs: [],
			annotations: [],
		};
		const send = rehydrateRendererCommandPayload("messages.send", {
			sessionId,
			input: plainInput,
		});
		const create = rehydrateRendererCommandPayload("chat.create", {
			projectId: "project-1",
			startupInput: structuredClone(plainInput),
		});

		expect(send.input).toBeInstanceOf(ComposerInput);
		expect(create.startupInput).toBeInstanceOf(ComposerInput);
		expect(send.input).toMatchObject(plainInput);
	});

	it("retains a sent-message fence until the authoritative turn is visible", () => {
		const messageId = MessageId.make("first-message");
		const command: ClientCommand = {
			kind: "messages.send",
			commandId: CommandId.make(`message-send:${messageId}`),
			environmentId,
			resource: sessionTimelineResourceKey(ref),
			payload: {
				commandId: CommandId.make(`message-send:${messageId}`),
				sessionId,
				text: "hello",
				clientMessageId: messageId,
			},
			retry: "safe",
			createdAt: 1,
			awaitResourceReflection: true,
			resourceReflection: { cursor: { epoch: "epoch-1", version: 1 } },
		};
		const userMessage = Message.make({
			id: messageId,
			sessionId,
			role: "user",
			content: { _tag: "user", text: "hello", goal: false },
			createdAt: new Date(1),
		});
		const projection = SessionTimelineProjection.make({
			messages: [userMessage],
			status: "idle",
			currentTurn: null,
			queue: QueueState.make({ items: [], paused: false }),
			permissionMode: "default",
			runtimeMode: "full-access",
		});

		expect(
			sessionMessageCommandReflected(command, {
				data: projection,
				origin: "runtime",
				connection: "connected",
				cursor: { epoch: "epoch-1", version: 2 },
				sync: "live",
				generation: 1,
				pendingCommands: [],
				failedCommands: [],
			}),
		).toBe(false);
		expect(
			sessionMessageCommandReflected(command, {
				data: SessionTimelineProjection.make({
					...projection,
					status: "running",
					currentTurn: { turnId: AgentTurnId.make("turn-1"), phase: "running" },
				}),
				origin: "runtime",
				connection: "connected",
				cursor: { epoch: "epoch-1", version: 3 },
				sync: "live",
				generation: 1,
				pendingCommands: [],
				failedCommands: [],
			}),
		).toBe(true);
	});

	it("atomically replaces resource registrations during hot reload", () => {
		const firstDriver = registerRendererResourceDriver(
			"hmr-test-resource",
			() => null,
		);
		const secondDriver = registerRendererResourceDriver(
			"hmr-test-resource",
			() => null,
		);
		const persistence = {
			loadResource: async () => null,
			saveResource: async () => undefined,
			removeResource: async () => undefined,
		};
		const firstPersistence = registerRendererResourcePersistence(
			"hmr-test-resource",
			persistence,
		);
		const secondPersistence = registerRendererResourcePersistence(
			"hmr-test-resource",
			{ ...persistence },
		);

		// Stale module cleanup must not remove the replacement registration.
		firstDriver();
		firstPersistence();
		secondDriver();
		secondPersistence();
	});

	it("shares one live timeline stream across two renderer consumers", async () => {
		let streamStarts = 0;
		let transportReleases = 0;
		const frames = Effect.runSync(Queue.unbounded());
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"session.events": () => {
						streamStarts += 1;
						return Stream.fromQueue(frames);
					},
				}) as never,
			async () => {
				transportReleases += 1;
			},
		);

		const first = retainSessionTimeline(ref, "connect");
		const second = retainSessionTimeline(ref, "connect");
		await waitUntil(() => streamStarts === 1);

		Queue.offerUnsafe(frames, {
			kind: "snapshot",
			sessionId,
			throughVersion: 0,
			cursor: { epoch: "epoch-1", version: 0 },
			projection: SessionTimelineProjection.make({
				messages: [],
				status: "running",
				currentTurn: null,
				queue: QueueState.make({ items: [], paused: false }),
				permissionMode: "default",
				runtimeMode: "approval-required",
			}),
		});
		Queue.offerUnsafe(frames, {
			kind: "event",
			eventId: "event-1",
			sessionId,
			streamVersion: 1,
			cursor: { epoch: "epoch-1", version: 1 },
			event: {
				_tag: "MessagePersisted",
				message: Message.make({
					id: MessageId.make("message-1"),
					sessionId,
					role: "assistant",
					content: { _tag: "assistant", text: "live" },
					createdAt: new Date(),
				}),
			},
		});

		await waitUntil(
			() =>
				getRendererClientBus().snapshot(first.key).data?.messages.length === 1,
		);
		expect(getRendererClientBus().snapshot(second.key).cursor?.version).toBe(1);
		first.lease.release();
		expect(streamStarts).toBe(1);
		expect(transportReleases).toBe(0);
		second.lease.release();
		await waitUntil(() => transportReleases === 1);
		expect(getRendererClientBus().connection(environmentId).phase).toBe(
			"dormant",
		);
	});

	it("lets EnvironmentRuntime exclusively schedule reconnect for a passive session", async () => {
		let sessions = 0;
		let disposals = 0;
		let closeCurrent: (cause: Error) => void = () => undefined;
		const closes: Array<(cause: Error) => void> = [];
		const frames = Effect.runSync(Queue.unbounded());
		setSessionTimelineRpcSessionForTest(async (_environmentId, onClose) => {
			sessions += 1;
			closes.push(onClose);
			closeCurrent = onClose;
			return {
				client: {
					"session.events": () => Stream.fromQueue(frames),
				} as never,
				dispose: async () => {
					disposals += 1;
				},
			};
		});

		const retained = retainSessionTimeline(ref, "connect");
		await waitUntil(() => sessions === 1);
		expect(getRendererClientBus().connection(environmentId)).toMatchObject({
			phase: "connected",
			generation: 1,
		});
		closeCurrent(new Error("WebSocket closed (1006)."));
		await waitUntil(() => disposals === 1);
		expect(sessions).toBe(1);
		expect(getRendererClientBus().connection(environmentId)).toMatchObject({
			phase: "reconnecting",
			generation: 1,
		});

		await new Promise((resolve) => setTimeout(resolve, 650));
		await waitUntil(() => sessions === 2);
		expect(getRendererClientBus().connection(environmentId)).toMatchObject({
			phase: "connected",
			generation: 2,
		});
		closes[0]?.(new Error("late close from generation one"));
		expect(getRendererClientBus().connection(environmentId)).toMatchObject({
			phase: "connected",
			generation: 2,
		});
		expect(sessions).toBe(2);
		retained.lease.release();
		await waitUntil(() => disposals === 2);
		expect(getRendererClientBus().connection(environmentId).phase).toBe(
			"dormant",
		);
	});

	it("classifies a rejected cloud account as blocked auth", async () => {
		registerEnvironmentActivationForTest(environmentId, async () => {
			throw new CloudWorkspaceOpError({ code: "not-allowed" });
		});

		const retained = retainSessionTimeline(ref, "connect");
		await waitUntil(
			() =>
				getRendererClientBus().connection(environmentId).phase ===
				"blocked-auth",
		);
		expect(getRendererClientBus().connection(environmentId).error).toBe(
			"not-allowed",
		);
		retained.lease.release();
	});

	it("keeps revoked private-beta access cached without retrying", async () => {
		let attempts = 0;
		registerEnvironmentActivationForTest(environmentId, async () => {
			attempts += 1;
			throw new CloudWorkspaceOpError({ code: "beta-access-required" });
		});

		const retained = retainSessionTimeline(ref, "connect");
		await waitUntil(
			() =>
				getRendererClientBus().connection(environmentId).phase === "revoked",
		);
		expect(getRendererClientBus().connection(environmentId).error).toBe(
			"beta-access-required",
		);
		await new Promise((resolve) => setTimeout(resolve, 650));
		expect(attempts).toBe(1);
		retained.lease.release();
	});

	it("restarts a provisional session timeline after its creation is acknowledged", async () => {
		let streamStarts = 0;
		const frames = Effect.runSync(Queue.unbounded());
		setSessionTimelineRpcSessionForTest(async () => ({
			client: {
				"session.events": () => {
					streamStarts += 1;
					return streamStarts === 1
						? Stream.fail(new SessionNotFoundError({ sessionId }))
						: Stream.fromQueue(frames);
				},
			} as never,
			dispose: async () => undefined,
		}));

		const retained = retainSessionTimeline(ref, "connect");
		await waitUntil(
			() => getRendererClientBus().snapshot(retained.key).sync === "failed",
		);
		expect(getRendererClientBus().connection(environmentId).phase).toBe(
			"connected",
		);
		// New-chat creation installs its optimistic queue before ChatView owns the
		// stream. Reproduce that cursorless runtime projection here.
		expect(updateOptimisticSessionQueue(ref, (queue) => queue)).toBe(true);
		const provisional = getRendererClientBus().snapshot(retained.key);
		expect(provisional.cursor).toBeNull();
		expect(provisional.data).not.toBeNull();
		expect(restartProvisionalSessionTimeline(ref, provisional)).toBe(true);
		await waitUntil(() => streamStarts === 2);
		Queue.offerUnsafe(frames, {
			kind: "snapshot",
			sessionId,
			throughVersion: 0,
			cursor: { epoch: "created", version: 0 },
			projection: SessionTimelineProjection.make({
				messages: [],
				status: "idle",
				currentTurn: null,
				queue: QueueState.make({ items: [], paused: false }),
				permissionMode: "default",
				runtimeMode: "approval-required",
			}),
		});
		Queue.offerUnsafe(frames, {
			kind: "synchronized",
			sessionId,
			throughVersion: 0,
			cursor: { epoch: "created", version: 0 },
		});
		await waitUntil(
			() => getRendererClientBus().snapshot(retained.key).sync === "live",
		);
		expect(
			restartProvisionalSessionTimeline(
				ref,
				getRendererClientBus().snapshot(retained.key),
			),
		).toBe(false);
		retained.lease.release();
	});

	it("seeds an empty provisional timeline with its startup queue item", () => {
		const key = sessionTimelineResourceKey(ref);
		getRendererClientBus().snapshot(key);
		const queued = QueuedMessage.make({
			id: "queue-startup",
			sessionId,
			input: ComposerInput.make({
				text: "visible immediately",
				attachments: [],
				fileRefs: [],
				skillRefs: [],
				annotations: [],
			}),
			position: 0,
			createdAt: new Date(1),
			updatedAt: new Date(1),
			ready: true,
		});

		expect(
			updateOptimisticSessionQueue(ref, () =>
				QueueState.make({ items: [queued], paused: false }),
			),
		).toBe(true);
		expect(getRendererClientBus().snapshot(key).data?.queue.items).toEqual([
			queued,
		]);
	});

	it("seeds a cloud launch message before its first timeline consumer mounts", () => {
		const key = sessionTimelineResourceKey(ref);
		const message = Message.make({
			id: MessageId.make("cloud-launch-message"),
			sessionId,
			role: "user",
			content: { _tag: "user", text: "visible during startup", goal: false },
			createdAt: new Date(1),
		});

		expect(addOptimisticSessionMessage(ref, message)).toBe(true);
		expect(getRendererClientBus().snapshot(key).data?.messages).toEqual([
			message,
		]);
	});

	it("restores an accepted optimistic prompt from the durable outbox", async () => {
		const key = sessionTimelineResourceKey(ref);
		const messageId = MessageId.make("accepted-after-restart");
		const commandId = CommandId.make(`message-send:${messageId}`);
		const command: ClientCommand = {
			kind: "messages.send",
			commandId,
			environmentId,
			resource: key,
			payload: {
				commandId,
				sessionId,
				input: structuredClone(
					ComposerInput.make({
						text: "survives the restart",
						attachments: [],
						fileRefs: [],
						skillRefs: [],
						annotations: [],
					}),
				),
				asGoal: true,
				clientMessageId: messageId,
			},
			retry: "safe",
			createdAt: 123,
		};
		const fingerprint = commandFingerprint(command);
		await createClientCommandOutbox().putOutbox({
			command,
			fingerprint,
			acceptance: CommandAcceptance.make({
				commandId,
				workspaceSequence: 4,
				revision: 8,
				acceptedAt: 120,
				state: "waiting-for-runtime",
			}),
			attempts: 1,
			lastAttemptAt: 121,
		});
		await resetSessionTimelineClientBus();

		const retained = retainSessionTimeline(ref, "cache-only");
		await waitUntil(
			() =>
				getRendererClientBus().snapshot(key).data?.messages[0]?.id ===
				messageId,
		);

		expect(
			getRendererClientBus().snapshot(key).data?.messages[0],
		).toMatchObject({
			id: messageId,
			sessionId,
			role: "user",
			content: {
				_tag: "user",
				text: "survives the restart",
				goal: true,
			},
			createdAt: new Date(123),
		});
		retained.lease.release();
	});

	it("restores the same prompt after a crash before acceptance was recorded", async () => {
		const key = sessionTimelineResourceKey(ref);
		const messageId = MessageId.make("accepted-response-lost");
		const commandId = CommandId.make(`message-send:${messageId}`);
		const command: ClientCommand = {
			kind: "messages.send",
			commandId,
			environmentId,
			resource: key,
			payload: {
				commandId,
				sessionId,
				input: structuredClone(
					ComposerInput.make({
						text: "recover the exact pending prompt",
						attachments: [],
						fileRefs: [],
						skillRefs: [],
						annotations: [],
					}),
				),
				clientMessageId: messageId,
			},
			retry: "safe",
			createdAt: 456,
		};
		await createClientCommandOutbox().putOutbox({
			command,
			fingerprint: commandFingerprint(command),
			attempts: 1,
			lastAttemptAt: 457,
		});
		await resetSessionTimelineClientBus();

		const retained = retainSessionTimeline(ref, "cache-only");
		await waitUntil(
			() =>
				getRendererClientBus().snapshot(key).data?.messages[0]?.id ===
				messageId,
		);

		expect(
			getRendererClientBus()
				.snapshot(key)
				.data?.messages.filter((message) => message.id === messageId),
		).toHaveLength(1);
		expect(
			getRendererClientBus().snapshot(key).data?.messages[0],
		).toMatchObject({
			id: messageId,
			sessionId,
			role: "user",
			content: {
				_tag: "user",
				text: "recover the exact pending prompt",
				goal: false,
			},
			createdAt: new Date(456),
		});
		retained.lease.release();
	});

	it("prepares a woken environment on the same passive session", async () => {
		let sessions = 0;
		let preparedClient: unknown = null;
		const frames = Effect.runSync(Queue.unbounded());
		const client = {
			"session.events": () => Stream.fromQueue(frames),
		} as never;
		setSessionTimelineRpcSessionForTest(async () => {
			sessions += 1;
			return { client, dispose: async () => undefined };
		});
		registerEnvironmentActivationForTest(
			environmentId,
			async () => undefined,
			async (resolved) => {
				preparedClient = resolved;
			},
		);

		const retained = retainSessionTimeline(ref, "wake");
		await waitUntil(
			() =>
				getRendererClientBus().connection(environmentId).phase === "connected",
		);
		expect(sessions).toBe(1);
		expect(preparedClient).toBe(client);
		retained.lease.release();
	});

	it("uses the mailbox for a sleeping cloud workspace before gateway attachment", async () => {
		const bus = getRendererClientBus();
		const flush = vi
			.spyOn(bus, "flushDurableOutbox")
			.mockResolvedValue(undefined);
		let prepareCalls = 0;
		registerEnvironmentActivationForTest(
			environmentId,
			async () => {
				prepareCalls += 1;
			},
			undefined,
			"cloud-workspace",
		);
		expect(flush).toHaveBeenCalledWith(environmentId);
		flush.mockRestore();

		const messageId = MessageId.make("sleeping-mailbox-message");
		const commandId = CommandId.make(`message-send:${messageId}`);
		const command: ClientCommand = {
			kind: "messages.send",
			commandId,
			environmentId,
			resource: sessionTimelineResourceKey(ref),
			payload: {
				commandId,
				sessionId,
				clientMessageId: messageId,
				input: ComposerInput.make({
					text: "deliver while sleeping",
					attachments: [],
					fileRefs: [],
					skillRefs: [],
					annotations: [],
				}),
			},
			retry: "safe",
			createdAt: 10,
		};
		const start = vi.fn();
		const dispose = vi.fn();
		const dispatch = vi
			.spyOn(cloudCommandTransport, "dispatch")
			.mockImplementation(({ fingerprint }) => ({
				accepted: Promise.resolve(
					CommandAcceptance.make({
						commandId,
						workspaceSequence: 1,
						revision: 1,
						acceptedAt: 11,
						state: "waiting-for-runtime",
					}),
				),
				result: Promise.resolve({
					commandId,
					fingerprint,
					receivedAt: 12,
					result: { accepted: true },
				}),
				encryptedEnvelope: Promise.resolve({ opaque: true }),
				deliveryFingerprint: Promise.resolve("hmac-sha256:sleeping"),
				start,
				dispose,
				cancel: async () => ({}) as never,
				subscribeStatus: () => () => undefined,
			}));

		await expect(bus.dispatch(command)).resolves.toMatchObject({ commandId });
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(start).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(prepareCalls).toBe(0);
		expect(bus.connection(environmentId).phase).toBe("dormant");
	});

	it("prepares a connected environment before acquiring its socket", async () => {
		const order: string[] = [];
		const frames = Effect.runSync(Queue.unbounded());
		setSessionTimelineRpcSessionForTest(async () => {
			order.push("socket");
			return {
				client: {
					"session.events": () => Stream.fromQueue(frames),
				} as never,
				dispose: async () => undefined,
			};
		});
		registerEnvironmentActivationForTest(environmentId, async (activation) => {
			order.push(`prepare:${activation}`);
		});

		const retained = retainSessionTimeline(ref, "connect");
		await waitUntil(
			() =>
				getRendererClientBus().connection(environmentId).phase === "connected",
		);
		expect(order).toEqual(["prepare:connect", "socket"]);
		retained.lease.release();
	});

	it("single-flights older pages, dedupes rows, and preserves the live cursor", async () => {
		const frames = Effect.runSync(Queue.unbounded());
		let pageCalls = 0;
		let pageInput: { beforeSequence?: number; limit?: number } | null = null;
		let releasePage!: () => void;
		const pageGate = new Promise<void>((resolve) => {
			releasePage = resolve;
		});
		const existing = Message.make({
			id: MessageId.make("message-current"),
			sessionId,
			role: "assistant",
			content: { _tag: "assistant", text: "current" },
			createdAt: new Date(2),
		});
		const older = Message.make({
			id: MessageId.make("message-older"),
			sessionId,
			role: "user",
			content: { _tag: "user", text: "older" },
			createdAt: new Date(1),
		});
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"session.events": () => Stream.fromQueue(frames),
					"session.messages.page": (input: typeof pageInput) =>
						Effect.promise(async () => {
							pageCalls += 1;
							pageInput = input;
							await pageGate;
							return {
								messages: [older, existing],
								olderMessageSequence: 10,
							};
						}),
				}) as never,
		);

		const retained = retainSessionTimeline(ref, "connect");
		Queue.offerUnsafe(frames, {
			kind: "snapshot",
			sessionId,
			throughVersion: 7,
			cursor: { epoch: "epoch-page", version: 7 },
			olderMessageSequence: 20,
			projection: SessionTimelineProjection.make({
				messages: [existing],
				status: "running",
				currentTurn: null,
				queue: QueueState.make({ items: [], paused: false }),
				permissionMode: "default",
				runtimeMode: "approval-required",
			}),
		});
		await waitUntil(
			() =>
				getRendererClientBus().snapshot(retained.key).data
					?.olderMessageSequence === 20,
		);

		const first = loadOlderSessionMessages(ref);
		const duplicate = loadOlderSessionMessages(ref);
		expect(duplicate).toBe(first);
		releasePage();
		await expect(first).resolves.toEqual({
			applied: true,
			loaded: 1,
			hasMore: true,
		});
		expect(pageCalls).toBe(1);
		expect(pageInput).toMatchObject({ beforeSequence: 20, limit: 100 });
		expect(getRendererClientBus().snapshot(retained.key)).toMatchObject({
			cursor: { epoch: "epoch-page", version: 7 },
			data: {
				messages: [older, existing],
				olderMessageSequence: 10,
			},
		});
		Queue.offerUnsafe(frames, {
			kind: "event",
			eventId: "event-after-page",
			sessionId,
			streamVersion: 8,
			cursor: { epoch: "epoch-page", version: 8 },
			event: {
				_tag: "StatusSet",
				status: "idle",
			},
		});
		await waitUntil(
			() => getRendererClientBus().snapshot(retained.key).cursor?.version === 8,
		);
		expect(getRendererClientBus().snapshot(retained.key)).toMatchObject({
			cursor: { epoch: "epoch-page", version: 8 },
			data: {
				messages: [older, existing],
				olderMessageSequence: 10,
				status: "idle",
			},
		});
		retained.lease.release();
	});

	it("drops an older-page response after the renderer bus generation changes", async () => {
		const frames = Effect.runSync(Queue.unbounded());
		let resolvePage!: (value: {
			messages: readonly Message[];
			olderMessageSequence: number | null;
		}) => void;
		const page = new Promise<{
			messages: readonly Message[];
			olderMessageSequence: number | null;
		}>((resolve) => {
			resolvePage = resolve;
		});
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"session.events": () => Stream.fromQueue(frames),
					"session.messages.page": () => Effect.promise(() => page),
				}) as never,
		);
		const retained = retainSessionTimeline(ref, "connect");
		Queue.offerUnsafe(frames, {
			kind: "snapshot",
			sessionId,
			throughVersion: 2,
			cursor: { epoch: "epoch-stale", version: 2 },
			olderMessageSequence: 9,
			projection: SessionTimelineProjection.make({
				messages: [],
				status: "running",
				currentTurn: null,
				queue: QueueState.make({ items: [], paused: false }),
				permissionMode: "default",
				runtimeMode: "approval-required",
			}),
		});
		await waitUntil(
			() =>
				getRendererClientBus().snapshot(retained.key).data
					?.olderMessageSequence === 9,
		);
		const request = loadOlderSessionMessages(ref);
		resetSessionTimelineClientBusForTest();
		resolvePage({ messages: [], olderMessageSequence: null });
		await expect(request).resolves.toEqual({
			applied: false,
			loaded: 0,
			hasMore: true,
		});
	});

	it("loads an older checkpoint page without connecting a paused environment", async () => {
		const older = Message.make({
			id: MessageId.make("offline-older"),
			sessionId,
			role: "assistant",
			content: { _tag: "assistant", text: "from R2" },
			createdAt: new Date(1),
		});
		registerSessionTimelineCheckpointSynchronizer(environmentId, async () => ({
			data: SessionTimelineProjection.make({
				messages: [],
				olderMessageSequence: 20,
				status: "idle",
				currentTurn: null,
				queue: QueueState.make({ items: [], paused: false }),
				permissionMode: "default",
				runtimeMode: "approval-required",
			}),
			cursor: { epoch: "r2-page", version: 8 },
			origin: "checkpoint",
		}));
		let pageCalls = 0;
		registerSessionTimelineOlderPageSynchronizer(
			environmentId,
			async (_ref, cursor, beforeSequence) => {
				pageCalls += 1;
				expect(cursor).toEqual({ epoch: "r2-page", version: 8 });
				expect(beforeSequence).toBe(20);
				if (pageCalls === 1) return null;
				return { messages: [older], olderMessageSequence: null };
			},
		);
		const retained = retainSessionTimeline(ref, "sync");
		await waitUntil(
			() =>
				getRendererClientBus().snapshot(retained.key).origin === "checkpoint",
		);

		await expect(
			completeOlderSessionMessages(ref, {
				retryDelay: async () => undefined,
			}),
		).resolves.toBeUndefined();
		expect(pageCalls).toBe(2);
		expect(getRendererClientBus().snapshot(retained.key)).toMatchObject({
			connection: "dormant",
			data: { messages: [older], olderMessageSequence: null },
		});
		retained.lease.release();
	});

	it("routes resource persistence by kind without creating another bus", async () => {
		const terminalKey = makeResourceKey<{ phase: string }>("terminal", {
			environmentId,
			terminalId: PtyId.make("terminal-persistence"),
		});
		const stored = new Map<string, PersistedResource<unknown>>();
		const unregister = registerRendererResourcePersistence("terminal", {
			loadResource: async (key) =>
				(stored.get(resourceKeyId(key)) as PersistedResource<never>) ?? null,
			saveResource: async (key, value) => {
				stored.set(resourceKeyId(key), value);
			},
			removeResource: async (key) => {
				stored.delete(resourceKeyId(key));
			},
		});
		stored.set(resourceKeyId(terminalKey), {
			data: { phase: "cached" },
			cursor: { epoch: "pty", version: 4 },
			storedAt: 1,
		});
		const bus = getRendererClientBus();
		const lease = bus.retain(terminalKey, { activation: "cache-only" });
		await waitUntil(() => bus.snapshot(terminalKey).data !== null);
		expect(bus.snapshot(terminalKey)).toMatchObject({
			data: { phase: "cached" },
			origin: "cache",
			cursor: { epoch: "pty", version: 4 },
		});
		lease.release();
		unregister();
	});
});
