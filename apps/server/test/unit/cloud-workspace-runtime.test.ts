import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	AgentSessionId,
	ChatId,
	CloudCommandEnvelope,
	CommandId,
	Message,
	MessageId,
	QueueState,
	RuntimeAcknowledgment,
	RuntimeLease,
	SessionId,
	SessionTimelineProjection,
} from "@zuse/contracts";
import {
	cloudCommandAdditionalData,
	decryptCloudCommandBody,
	encryptCloudCommandBody,
	keyedCloudCommandFingerprint,
} from "@zuse/utils/cloud-command-crypto";
import { bytesToBase64Url } from "@zuse/utils/cloud-transcript-crypto";
import { Clock, Deferred, Effect, Fiber, Redacted, Ref } from "effect";
import { TestClock } from "effect/testing";
import { generateKeyPair, jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";
import {
	applyCloudMailboxLease,
	bufferWorkspaceLocalFrame,
	CloudMailboxApplyError,
	type CloudMailboxCommandIdentity,
	type CloudMailboxCommandReceipt,
	type CloudMailboxReceiptStore,
	CloudWorkspaceRuntimeError,
	classifyCloudMailboxAckFailure,
	cloudGatewayCloseReason,
	decodeImageProviderSecrets,
	makeCloudRuntimeCheckpointPublisher,
	makeCloudRuntimeSummaryPublisher,
	resolveCloudRuntimeActiveSession,
	retryCloudWorkspaceBootstrap,
	runCloudMailboxConsumerCycle,
	runtimeCredentialRenewalDelayMs,
	runtimeReadyPhaseOnGatewayOpen,
	signRuntimeRenewalProof,
	startCloudWorkspaceLaunchIntent,
	writeGithubBrokerState,
} from "../../src/api/cloud-workspace-runtime.ts";

const makeDurableMessageLease = async (
	input: { readonly text?: string } = {},
) => {
	const transcriptKey = bytesToBase64Url(new Uint8Array(32).fill(17));
	const commandId = CommandId.make("message-send:message-1");
	const sessionId = AgentSessionId.make("session-1");
	const plaintext = new TextEncoder().encode(
		JSON.stringify({
			commandId,
			sessionId,
			text: input.text ?? "continue after wake",
			clientMessageId: MessageId.make("message-1"),
		}),
	);
	const fingerprint = await keyedCloudCommandFingerprint({
		encodedKey: transcriptKey,
		canonicalPlaintext: plaintext,
	});
	const metadata = {
		protocolVersion: 3 as const,
		workspaceId: "workspace-1",
		sessionId,
		commandId,
		kind: "messages.send",
		fingerprint,
		schemaVersion: 1,
		keyVersion: 1,
		destructionFence: 0,
		createdAt: 1,
		dependencies: [],
	};
	const encrypted = await encryptCloudCommandBody({
		encodedKey: transcriptKey,
		additionalData: cloudCommandAdditionalData(metadata),
		plaintext,
	});
	return {
		transcriptKey,
		lease: RuntimeLease.make({
			command: CloudCommandEnvelope.make({ ...metadata, ...encrypted }),
			workspaceSequence: 1,
			leaseToken: "lease-1",
			leaseDeadline: 10_000,
			runtimeGeneration: 7,
			providerSandboxId: "sandbox-1",
			storageIncarnationId: "storage-1",
		}),
	};
};

const receiptFor = (
	input: Awaited<ReturnType<typeof makeDurableMessageLease>>,
	overrides: Partial<CloudMailboxCommandReceipt> = {},
): CloudMailboxCommandReceipt => {
	const eventIds = ["event-message", "event-turn"];
	const streamVersion = 4;
	return {
		commandId: input.lease.command.commandId,
		streamKind: "session",
		streamId: input.lease.command.sessionId,
		streamVersion,
		eventIdsJson: JSON.stringify(eventIds),
		resultJson: JSON.stringify({
			commandId: input.lease.command.commandId,
			streamId: input.lease.command.sessionId,
			streamVersion,
			eventIds,
		}),
		fingerprint: null,
		commandKind: null,
		schemaVersion: null,
		storageIncarnationId: null,
		messageEventJson: JSON.stringify({
			_tag: "MessagePersisted",
			messageId: "message-1",
			turnId: "turn-1",
			role: "user",
			kind: "user",
			parentItemId: null,
			contentJson: JSON.stringify({
				_tag: "user",
				text: "continue after wake",
				goal: false,
			}),
		}),
		providerTurnEventJson: JSON.stringify({
			_tag: "ProviderTurnRequested",
			turnId: "turn-1",
			providerInputJson: JSON.stringify({
				text: "continue after wake",
				attachments: [],
				fileRefs: [],
				skillRefs: [],
				annotations: [],
			}),
		}),
		...overrides,
	};
};

const identityFor = (
	input: Awaited<ReturnType<typeof makeDurableMessageLease>>,
): CloudMailboxCommandIdentity => ({
	commandId: input.lease.command.commandId,
	streamId: input.lease.command.sessionId,
	fingerprint: input.lease.command.fingerprint,
	commandKind: input.lease.command.kind,
	schemaVersion: input.lease.command.schemaVersion,
	storageIncarnationId: input.lease.storageIncarnationId,
});

const boundReceiptFor = (
	input: Awaited<ReturnType<typeof makeDurableMessageLease>>,
): CloudMailboxCommandReceipt => receiptFor(input, identityFor(input));

const makeReceiptStore = (initial: CloudMailboxCommandReceipt | null) => {
	let receipt = initial;
	const store: CloudMailboxReceiptStore = {
		read: () => Effect.sync(() => receipt),
		bindIdentity: (identity) =>
			Effect.sync(() => {
				if (receipt === null) return;
				const conflicts =
					receipt.commandId !== identity.commandId ||
					receipt.streamId !== identity.streamId ||
					(receipt.fingerprint !== null &&
						receipt.fingerprint !== identity.fingerprint);
				if (conflicts) return;
				receipt = {
					...receipt,
					fingerprint: receipt.fingerprint ?? identity.fingerprint,
					commandKind: receipt.commandKind ?? identity.commandKind,
					schemaVersion: receipt.schemaVersion ?? identity.schemaVersion,
					storageIncarnationId:
						receipt.storageIncarnationId ?? identity.storageIncarnationId,
				};
			}),
	};
	return {
		store,
		read: () => receipt,
		write: (next: CloudMailboxCommandReceipt | null) => {
			receipt = next;
		},
	};
};

describe("cloud workspace bootstrap", () => {
	it("publishes owner-only state for lazy GitHub credentials", async () => {
		const runtimeData = await mkdtemp(join(tmpdir(), "zuse-runtime-github-"));
		vi.stubEnv("ZUSE_USER_DATA", runtimeData);
		try {
			const config = {
				workspaceId: "workspace-1",
				apiUrl: "https://api.test",
				bootToken: Redacted.make("boot-token"),
				localPort: 47_837,
				workspaceRoot: "/home/repos/acme/example",
			};
			await Effect.runPromise(
				writeGithubBrokerState(config, "runtime-credential"),
			);
			expect(
				JSON.parse(
					await readFile(join(runtimeData, "github-broker.json"), "utf8"),
				),
			).toEqual({
				credentialUrl:
					"https://api.test/v1/cloud/workspaces/workspace-1/runtime/github-credential",
			});
			expect(
				await readFile(join(runtimeData, "cloud-runtime-credential"), "utf8"),
			).toBe("runtime-credential\n");
			expect(
				(await stat(join(runtimeData, "cloud-runtime-credential"))).mode &
					0o777,
			).toBe(0o600);
			await Effect.runPromise(
				writeGithubBrokerState(config, "rotated-runtime-credential"),
			);
			expect(
				await readFile(join(runtimeData, "cloud-runtime-credential"), "utf8"),
			).toBe("rotated-runtime-credential\n");
		} finally {
			vi.unstubAllEnvs();
			await rm(runtimeData, { recursive: true, force: true });
		}
	});

	it("accepts a partial image provider configuration", async () => {
		const decoded = await Effect.runPromise(
			decodeImageProviderSecrets(
				JSON.stringify({
					claude: { method: "subscription", secret: "machine-token" },
				}),
			),
		);

		expect(decoded).toEqual({
			claude: { method: "subscription", secret: "machine-token" },
		});
	});

	it("rejects unknown image provider keys", async () => {
		const result = await Effect.runPromiseExit(
			decodeImageProviderSecrets(
				JSON.stringify({
					unknown: { method: "api-key", secret: "machine-token" },
				}),
			),
		);

		expect(result._tag).toBe("Failure");
	});

	it("publishes bounded older transcript pages only for an urgent checkpoint", async () => {
		const sessionId = AgentSessionId.make("session-pages");
		const older = Message.make({
			id: MessageId.make("message-older"),
			sessionId,
			role: "assistant",
			content: { _tag: "assistant", text: "older durable output" },
			createdAt: new Date(1),
		});
		const headWrites: unknown[] = [];
		const pageWrites: Array<{ readonly beforeSequence: number }> = [];
		const publisher = await Effect.runPromise(
			makeCloudRuntimeCheckpointPublisher({
				workspaceId: "workspace-pages",
				sessionId,
				transcriptKey: bytesToBase64Url(new Uint8Array(32).fill(7)),
				read: Effect.succeed({
					cursor: { epoch: "epoch-pages", version: 9 },
					projection: SessionTimelineProjection.make({
						messages: [],
						olderMessageSequence: 20,
						status: "idle",
						currentTurn: null,
						queue: QueueState.make({ items: [], paused: false }),
						permissionMode: "default",
						runtimeMode: "approval-required",
					}),
				}),
				readPage: () =>
					Effect.succeed({
						messages: [older],
						olderMessageSequence: null,
					}),
				write: (checkpoint) =>
					Effect.sync(() => {
						headWrites.push(checkpoint);
					}),
				writePage: (page) =>
					Effect.sync(() => {
						pageWrites.push(page);
					}),
			}),
		);

		publisher.mark(true);
		expect(await Effect.runPromise(publisher.flush)).toBe(true);
		expect(headWrites).toHaveLength(1);
		expect(pageWrites).toEqual([
			expect.objectContaining({ beforeSequence: 20 }),
		]);
		expect(await Effect.runPromise(publisher.flush)).toBe(false);
	});

	it("publishes monotonic metadata and throttles only activity checkpoints", async () => {
		let now = 1_000;
		let title = "Initial title";
		let head = 4;
		const writes: Array<Record<string, unknown>> = [];
		const publisher = await Effect.runPromise(
			makeCloudRuntimeSummaryPublisher({
				now: Effect.sync(() => now),
				read: Effect.sync(() => ({
					title,
					lastActivityAt: now,
					activeSessionId: SessionId.make("session-1"),
					sessionHeadVersion: head,
				})),
				write: (summary) =>
					Effect.sync(() => {
						writes.push({ ...summary });
						return {
							applied: true,
							summaryRevision: summary.summaryRevision,
						};
					}),
			}),
		);

		expect(await Effect.runPromise(publisher.publish("activity"))).toBe(true);
		now += 1_000;
		expect(await Effect.runPromise(publisher.publish("activity"))).toBe(false);
		title = "Renamed immediately";
		head = 7;
		expect(await Effect.runPromise(publisher.publish("title"))).toBe(true);
		expect(await Effect.runPromise(publisher.publish("settled"))).toBe(true);

		expect(writes).toEqual([
			{
				summaryRevision: 1,
				title: "Initial title",
				lastActivityAt: 1_000,
				activeSessionId: "session-1",
				sessionHeadVersion: 4,
			},
			{
				summaryRevision: 2,
				title: "Renamed immediately",
				lastActivityAt: 2_000,
				activeSessionId: "session-1",
				sessionHeadVersion: 7,
			},
			{
				summaryRevision: 3,
				title: "Renamed immediately",
				lastActivityAt: 2_000,
				activeSessionId: "session-1",
				sessionHeadVersion: 7,
			},
		]);
		for (const summary of writes) {
			expect(summary).not.toHaveProperty("content");
			expect(summary).not.toHaveProperty("messages");
		}
	});

	it("rebases once when API already accepted a newer summary revision", async () => {
		const revisions: number[] = [];
		const publisher = await Effect.runPromise(
			makeCloudRuntimeSummaryPublisher({
				now: Effect.succeed(1_000),
				read: Effect.succeed({
					title: "Preserved runtime",
					lastActivityAt: 1_000,
					activeSessionId: SessionId.make("session-1"),
					sessionHeadVersion: 9,
				}),
				write: (summary) =>
					Effect.sync(() => {
						revisions.push(summary.summaryRevision);
						return summary.summaryRevision === 1
							? { applied: false, summaryRevision: 12 }
							: { applied: true, summaryRevision: summary.summaryRevision };
					}),
			}),
		);

		expect(await Effect.runPromise(publisher.publish("initial"))).toBe(true);
		expect(revisions).toEqual([1, 13]);
	});

	it("replaces a stale active-session pointer with the newest live sibling", () => {
		const chatId = ChatId.make("chat-1");
		const removed = SessionId.make("session-removed");
		const replacement = SessionId.make("session-replacement");
		expect(
			resolveCloudRuntimeActiveSession(
				{ id: chatId, activeSessionId: removed },
				[
					{
						id: SessionId.make("other-chat-session"),
						chatId: ChatId.make("chat-2"),
					},
					{ id: replacement, chatId },
				],
			),
		).toBe(replacement);
		expect(
			resolveCloudRuntimeActiveSession(
				{ id: chatId, activeSessionId: removed },
				[],
			),
		).toBeNull();
	});

	it("announces readiness when a preserved runtime reconnects", () => {
		expect(runtimeReadyPhaseOnGatewayOpen(false)).toBeNull();
		expect(runtimeReadyPhaseOnGatewayOpen(true)).toBe("repository-ready");
	});

	it("does not retry a gateway fence or authorization rejection", () => {
		expect(cloudGatewayCloseReason(4101)).toBe(
			"workspace_gateway_generation_changed",
		);
		expect(cloudGatewayCloseReason(4102)).toBe(
			"workspace_gateway_authorization_expired",
		);
		expect(cloudGatewayCloseReason(4103)).toBe(
			"workspace_gateway_update_required",
		);
		expect(cloudGatewayCloseReason(1006)).toBe(
			"workspace_gateway_disconnected",
		);
	});

	it("buffers the localhost RPC handshake only within a bounded handoff", () => {
		const queue = { frames: [] as Array<string | ArrayBuffer>, bytes: 0 };
		expect(bufferWorkspaceLocalFrame(queue, "handshake")).toBe(true);
		expect(
			bufferWorkspaceLocalFrame(queue, new Uint8Array([1, 2]).buffer),
		).toBe(true);
		expect(queue.frames).toEqual(["handshake", new Uint8Array([1, 2]).buffer]);
		expect(queue.bytes).toBe(11);
		expect(bufferWorkspaceLocalFrame(queue, new ArrayBuffer(256 * 1024))).toBe(
			false,
		);
		expect(queue.frames).toHaveLength(2);
	});

	it("renews a runtime credential at half-life", () => {
		expect(runtimeCredentialRenewalDelayMs(115_000, 100_000)).toBe(7_500);
		expect(runtimeCredentialRenewalDelayMs(99_000, 100_000)).toBe(0);
	});

	it("binds renewal proof to the runtime generation and gateway epoch", async () => {
		const keys = await generateKeyPair("EdDSA", { extractable: true });
		const proof = await Effect.runPromise(
			signRuntimeRenewalProof({
				privateKey: keys.privateKey,
				apiIssuer: "https://api.example.test",
				workspaceId: "workspace-1",
				requestId: "renewal-1",
				generation: 4,
				gatewayEpoch: 7,
				nowMs: 100_000,
			}),
		);
		const verified = await jwtVerify(proof, keys.publicKey, {
			audience: "https://api.example.test",
			typ: "workspace-runtime-renewal+jwt",
			currentDate: new Date(100_000),
		});
		expect(verified.payload).toMatchObject({
			workspaceId: "workspace-1",
			requestId: "renewal-1",
			generation: 4,
			gatewayEpoch: 7,
		});
	});

	it("retries a transient enrollment failure instead of leaving the runtime detached", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const attemptCount = yield* Ref.make(0);
				const bootstrap = Ref.updateAndGet(
					attemptCount,
					(count) => count + 1,
				).pipe(
					Effect.flatMap((attempt) =>
						attempt === 1
							? Effect.fail(new Error("api_401"))
							: Effect.succeed("connected"),
					),
				);
				const fiber = yield* Effect.forkDetach(
					retryCloudWorkspaceBootstrap(bootstrap),
				);

				yield* Effect.yieldNow;
				expect(yield* Ref.get(attemptCount)).toBe(1);

				yield* TestClock.adjust("1 second");
				expect(yield* Fiber.join(fiber)).toBe("connected");
				expect(yield* Ref.get(attemptCount)).toBe(2);
			}).pipe(Effect.provide(TestClock.layer())),
		);
	});

	it("replays a launch intent with one stable domain command and turn", async () => {
		const createChat = vi.fn(() =>
			Effect.succeed({
				chat: {} as never,
				initialSession: {} as never,
				initialMessage: null,
			}),
		);
		const workspaces = {
			list: () =>
				Effect.succeed([
					{ id: "folder-1", path: "/home/repos/example/project" },
				]),
			add: vi.fn(),
		} as never;
		const chats = { createChat } as never;
		const launchIntent = {
			commandId: "launch:workspace-1",
			turnId: "turn:workspace-1",
			title: "Durable launch",
			agent: "codex",
			model: "gpt-5",
			runtimeMode: "full-access" as const,
			permissions: [],
			firstMessage: "finish while the laptop is closed",
		};

		const start = () =>
			Effect.runPromise(
				startCloudWorkspaceLaunchIntent({
					workspaces,
					chats,
					chatId: "chat-1",
					sessionId: "session-1",
					workspaceRoot: "/home/repos/example/project",
					launchIntent,
				}),
			);
		await start();
		// The first acknowledgement can disappear between runtime and API. A
		// repeated encrypted intent must carry exactly the same durable identities.
		await start();

		expect(createChat).toHaveBeenCalledTimes(2);
		expect(createChat).toHaveBeenCalledWith(
			expect.objectContaining({
				chatId: "chat-1",
				initialSessionId: "session-1",
				commandId: "launch:workspace-1",
				initialTurnId: "turn:workspace-1",
				initialMessageId: "launch:workspace-1:message",
				initialPrompt: "finish while the laptop is closed",
				runtimeMode: "full-access",
			}),
		);
	});
});

describe("cloud workspace mailbox runtime", () => {
	it("rejects plaintext above the shared command limit before apply", async () => {
		const durable = await makeDurableMessageLease({
			text: "x".repeat(129 * 1024),
		});
		const sendMessage = vi.fn(() => Effect.void);

		const acknowledgment = await Effect.runPromise(
			applyCloudMailboxLease({
				config: { workspaceId: "workspace-1" },
				lease: durable.lease,
				runtimeGeneration: 7,
				providerSandboxId: "sandbox-1",
				nowMs: Effect.succeed(1),
				transcriptKey: durable.transcriptKey,
				storageIncarnationId: "storage-1",
				sendMessage,
				receipts: makeReceiptStore(null).store,
			}),
		);

		expect(acknowledgment).toMatchObject({
			state: "rejected",
			category: "command-payload-too-large",
		});
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "a stale runtime generation",
			runtimeGeneration: 8,
			providerSandboxId: "sandbox-1",
			storageIncarnationId: "storage-1",
			category: "runtime-generation-mismatch",
		},
		{
			name: "a different provider sandbox",
			runtimeGeneration: 7,
			providerSandboxId: "sandbox-2",
			storageIncarnationId: "storage-1",
			category: "runtime-provider-sandbox-mismatch",
		},
		{
			name: "a different storage incarnation",
			runtimeGeneration: 7,
			providerSandboxId: "sandbox-1",
			storageIncarnationId: "storage-2",
			category: "runtime-storage-incarnation-mismatch",
		},
	] as const)("rejects $name before applying the message", async ({
		runtimeGeneration,
		providerSandboxId,
		storageIncarnationId,
		category,
	}) => {
		const durable = await makeDurableMessageLease();
		const receipts = makeReceiptStore(null);
		const sendMessage = vi.fn(() => Effect.void);

		const acknowledgment = await Effect.runPromise(
			applyCloudMailboxLease({
				config: { workspaceId: "workspace-1" },
				lease: durable.lease,
				runtimeGeneration,
				providerSandboxId,
				nowMs: Effect.succeed(1),
				transcriptKey: durable.transcriptKey,
				storageIncarnationId,
				sendMessage,
				receipts: receipts.store,
			}),
		);

		expect(acknowledgment).toMatchObject({
			commandId: durable.lease.command.commandId,
			leaseToken: durable.lease.leaseToken,
			fingerprint: durable.lease.command.fingerprint,
			state: "rejected",
			category,
		});
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("acknowledges a new message only after its receipt is persisted", async () => {
		const durable = await makeDurableMessageLease();
		const receipts = makeReceiptStore(null);
		const sendMessage = vi.fn(() =>
			Effect.sync(() => receipts.write(boundReceiptFor(durable))),
		);

		const acknowledgment = await Effect.runPromise(
			applyCloudMailboxLease({
				config: { workspaceId: "workspace-1" },
				lease: durable.lease,
				runtimeGeneration: 7,
				providerSandboxId: "sandbox-1",
				nowMs: Effect.succeed(1),
				transcriptKey: durable.transcriptKey,
				storageIncarnationId: "storage-1",
				sendMessage,
				receipts: receipts.store,
			}),
		);

		expect(acknowledgment).not.toBeNull();
		if (acknowledgment === null)
			throw new Error("message apply was not proven");
		expect(acknowledgment.state).toBe("applied");
		expect(receipts.read()).toMatchObject({
			fingerprint: durable.lease.command.fingerprint,
			commandKind: "messages.send",
			schemaVersion: 1,
			storageIncarnationId: "storage-1",
		});
	});

	it("uses the committed receipt when post-commit message work defects", async () => {
		const durable = await makeDurableMessageLease();
		const receipts = makeReceiptStore(null);
		const sendMessage = vi.fn(() =>
			Effect.sync(() => receipts.write(boundReceiptFor(durable))).pipe(
				Effect.andThen(Effect.die("projection failed after commit")),
			),
		);

		const acknowledgment = await Effect.runPromise(
			applyCloudMailboxLease({
				config: { workspaceId: "workspace-1" },
				lease: durable.lease,
				runtimeGeneration: 7,
				providerSandboxId: "sandbox-1",
				nowMs: Effect.succeed(1),
				transcriptKey: durable.transcriptKey,
				storageIncarnationId: "storage-1",
				sendMessage,
				receipts: receipts.store,
			}),
		);

		expect(acknowledgment).toMatchObject({ state: "applied" });
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});

	it("adopts a matching v2 receipt committed during the apply race", async () => {
		const durable = await makeDurableMessageLease();
		const receipts = makeReceiptStore(null);
		const sendMessage = vi.fn(() =>
			Effect.sync(() => receipts.write(receiptFor(durable))),
		);

		const acknowledgment = await Effect.runPromise(
			applyCloudMailboxLease({
				config: { workspaceId: "workspace-1" },
				lease: durable.lease,
				runtimeGeneration: 7,
				providerSandboxId: "sandbox-1",
				nowMs: Effect.succeed(1),
				transcriptKey: durable.transcriptKey,
				storageIncarnationId: "storage-1",
				sendMessage,
				receipts: receipts.store,
			}),
		);

		expect(acknowledgment).toMatchObject({ state: "applied" });
		expect(receipts.read()).toMatchObject(identityFor(durable));
	});

	it("recovers an applied message receipt before acknowledging it", async () => {
		const durable = await makeDurableMessageLease();
		// This is the crash boundary after SessionDomain atomically committed the
		// prompt and mailbox identity but before the runtime sent the ACK.
		const receipts = makeReceiptStore(boundReceiptFor(durable));
		const sendMessage = vi.fn(() =>
			Effect.die(new Error("provider must not be re-entered")),
		);

		const acknowledgment = await Effect.runPromise(
			applyCloudMailboxLease({
				config: { workspaceId: "workspace-1" },
				lease: durable.lease,
				runtimeGeneration: 7,
				providerSandboxId: "sandbox-1",
				nowMs: Effect.succeed(1),
				transcriptKey: durable.transcriptKey,
				storageIncarnationId: "storage-1",
				sendMessage,
				receipts: receipts.store,
			}),
		);

		expect(acknowledgment).not.toBeNull();
		if (acknowledgment === null)
			throw new Error("persisted receipt was not recovered");
		expect(acknowledgment.state).toBe("applied");
		expect(sendMessage).not.toHaveBeenCalled();
		expect(receipts.read()).toMatchObject({
			fingerprint: durable.lease.command.fingerprint,
			commandKind: "messages.send",
			schemaVersion: 1,
			storageIncarnationId: "storage-1",
		});
		if (
			acknowledgment.resultIv === undefined ||
			acknowledgment.resultCiphertext === undefined
		)
			throw new Error("applied acknowledgment did not contain a result");
		const result = await decryptCloudCommandBody({
			encodedKey: durable.transcriptKey,
			additionalData: cloudCommandAdditionalData(durable.lease.command),
			iv: acknowledgment.resultIv,
			ciphertext: acknowledgment.resultCiphertext,
		});
		expect(JSON.parse(new TextDecoder().decode(result))).toEqual({
			commandId: durable.lease.command.commandId,
			result: null,
		});
	});

	it("binds and acknowledges a matching v2 receipt without replaying it", async () => {
		const durable = await makeDurableMessageLease();
		const receipts = makeReceiptStore(receiptFor(durable));
		const sendMessage = vi.fn(() => Effect.die("must not replay"));

		const acknowledgment = await Effect.runPromise(
			applyCloudMailboxLease({
				config: { workspaceId: "workspace-1" },
				lease: durable.lease,
				runtimeGeneration: 7,
				providerSandboxId: "sandbox-1",
				nowMs: Effect.succeed(1),
				transcriptKey: durable.transcriptKey,
				storageIncarnationId: "storage-1",
				sendMessage,
				receipts: receipts.store,
			}),
		);

		expect(acknowledgment).toMatchObject({ state: "applied" });
		expect(sendMessage).not.toHaveBeenCalled();
		expect(receipts.read()).toMatchObject(identityFor(durable));
	});

	it("terminalizes an applied command whose receipt cannot be proven", async () => {
		const durable = await makeDurableMessageLease();
		const receipts = makeReceiptStore(null);

		const acknowledgment = await Effect.runPromise(
			applyCloudMailboxLease({
				config: { workspaceId: "workspace-1" },
				lease: durable.lease,
				runtimeGeneration: 7,
				providerSandboxId: "sandbox-1",
				nowMs: Effect.succeed(1),
				transcriptKey: durable.transcriptKey,
				storageIncarnationId: "storage-1",
				sendMessage: () => Effect.void,
				receipts: receipts.store,
			}),
		);

		expect(acknowledgment).toMatchObject({
			state: "outcome-unknown",
			category: "runtime-receipt-missing",
		});
	});

	it("retries on a fenced generation after interruption before the receipt commit", async () => {
		const durable = await makeDurableMessageLease();
		const receipts = makeReceiptStore(null);
		const firstApplyStarted = await Effect.runPromise(Deferred.make<void>());
		let attempts = 0;
		const sendMessage = vi.fn(() => {
			attempts += 1;
			return attempts === 1
				? Deferred.succeed(firstApplyStarted, undefined).pipe(
						Effect.andThen(Effect.never),
					)
				: Effect.sync(() => receipts.write(boundReceiptFor(durable)));
		});
		const apply = (runtimeGeneration: number) =>
			applyCloudMailboxLease({
				config: { workspaceId: "workspace-1" },
				lease: RuntimeLease.make({
					...durable.lease,
					leaseToken: `lease-${runtimeGeneration}`,
					runtimeGeneration,
				}),
				runtimeGeneration,
				providerSandboxId: "sandbox-1",
				nowMs: Effect.succeed(1),
				transcriptKey: durable.transcriptKey,
				storageIncarnationId: "storage-1",
				sendMessage,
				receipts: receipts.store,
			});

		const first = await Effect.runPromise(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(apply(7), {
					startImmediately: true,
				});
				yield* Deferred.await(firstApplyStarted);
				yield* Fiber.interrupt(fiber);
				return yield* Fiber.await(fiber);
			}),
		);
		const recovered = await Effect.runPromise(apply(8));

		expect(first._tag).toBe("Failure");
		expect(recovered).toMatchObject({ state: "applied" });
		expect(sendMessage).toHaveBeenCalledTimes(2);
	});

	it("rejects a conflicting receipt before replaying the provider workflow", async () => {
		const durable = await makeDurableMessageLease();
		const receipts = makeReceiptStore(
			receiptFor(durable, { fingerprint: "hmac-sha256:other-command" }),
		);
		const sendMessage = vi.fn(() => Effect.void);

		const acknowledgment = await Effect.runPromise(
			applyCloudMailboxLease({
				config: { workspaceId: "workspace-1" },
				lease: durable.lease,
				runtimeGeneration: 7,
				providerSandboxId: "sandbox-1",
				nowMs: Effect.succeed(1),
				transcriptKey: durable.transcriptKey,
				storageIncarnationId: "storage-1",
				sendMessage,
				receipts: receipts.store,
			}),
		);

		expect(acknowledgment).not.toBeNull();
		expect(acknowledgment).toMatchObject({
			state: "rejected",
			category: "runtime-receipt-conflict",
		});
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("does not acknowledge a receipt whose durable events belong to another payload", async () => {
		const durable = await makeDurableMessageLease();
		const receipts = makeReceiptStore(
			receiptFor(durable, {
				messageEventJson: JSON.stringify({
					_tag: "MessagePersisted",
					messageId: "message-1",
					turnId: "turn-1",
					role: "user",
					kind: "user",
					parentItemId: null,
					contentJson: JSON.stringify({
						_tag: "user",
						text: "continue after wake",
						goal: false,
						origin: {
							chatId: "other-chat",
							sessionId: "other-session",
							providerId: "codex",
						},
					}),
				}),
			}),
		);
		const sendMessage = vi.fn(() => Effect.void);

		const acknowledgment = await Effect.runPromise(
			applyCloudMailboxLease({
				config: { workspaceId: "workspace-1" },
				lease: durable.lease,
				runtimeGeneration: 7,
				providerSandboxId: "sandbox-1",
				nowMs: Effect.succeed(1),
				transcriptKey: durable.transcriptKey,
				storageIncarnationId: "storage-1",
				sendMessage,
				receipts: receipts.store,
			}),
		);

		expect(acknowledgment).toMatchObject({
			state: "outcome-unknown",
			category: "runtime-receipt-invalid",
		});
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("does not publish unexpected apply failure details", async () => {
		const durable = await makeDurableMessageLease();
		const receipts = makeReceiptStore(null);

		const acknowledgment = await Effect.runPromise(
			applyCloudMailboxLease({
				config: { workspaceId: "workspace-1" },
				lease: durable.lease,
				runtimeGeneration: 7,
				providerSandboxId: "sandbox-1",
				nowMs: Effect.succeed(1),
				transcriptKey: durable.transcriptKey,
				storageIncarnationId: "storage-1",
				sendMessage: () =>
					Effect.die(new Error("Authorization: Bearer should-never-leak")),
				receipts: receipts.store,
			}),
		);

		expect(acknowledgment).toMatchObject({
			state: "outcome-unknown",
			category: "runtime-apply-failed",
		});
		expect(JSON.stringify(acknowledgment)).not.toContain("Bearer");
	});

	it("does not reject when legacy receipt binding is temporarily unavailable", async () => {
		const durable = await makeDurableMessageLease();
		const receipts = makeReceiptStore(receiptFor(durable));
		const sendMessage = vi.fn(() => Effect.void);

		const acknowledgment = await Effect.runPromise(
			applyCloudMailboxLease({
				config: { workspaceId: "workspace-1" },
				lease: durable.lease,
				runtimeGeneration: 7,
				providerSandboxId: "sandbox-1",
				nowMs: Effect.succeed(1),
				transcriptKey: durable.transcriptKey,
				storageIncarnationId: "storage-1",
				sendMessage,
				receipts: {
					...receipts.store,
					bindIdentity: () =>
						Effect.fail(
							new CloudMailboxApplyError({
								category: "runtime-receipt-store-unavailable",
							}),
						),
				},
			}),
		);

		expect(acknowledgment).toBeNull();
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("retries a transient receipt read without consuming the apply identity", async () => {
		const durable = await makeDurableMessageLease();
		const receipts = makeReceiptStore(null);
		let reads = 0;
		const sendMessage = vi.fn(() =>
			Effect.sync(() => receipts.write(boundReceiptFor(durable))),
		);
		const apply = () =>
			Effect.runPromise(
				applyCloudMailboxLease({
					config: { workspaceId: "workspace-1" },
					lease: durable.lease,
					runtimeGeneration: 7,
					providerSandboxId: "sandbox-1",
					nowMs: Effect.succeed(1),
					transcriptKey: durable.transcriptKey,
					storageIncarnationId: "storage-1",
					sendMessage,
					receipts: {
						...receipts.store,
						read: (commandId) => {
							reads += 1;
							return reads === 1
								? Effect.fail(
										new CloudMailboxApplyError({
											category: "runtime-receipt-store-unavailable",
										}),
									)
								: receipts.store.read(commandId);
						},
					},
				}),
			);

		expect(await apply()).toBeNull();
		expect(await apply()).toMatchObject({ state: "applied" });
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});

	it("does not begin a new apply after the runtime lease deadline", async () => {
		const durable = await makeDurableMessageLease();
		const receipts = makeReceiptStore(null);
		const sendMessage = vi.fn(() => Effect.void);

		const acknowledgment = await Effect.runPromise(
			applyCloudMailboxLease({
				config: { workspaceId: "workspace-1" },
				lease: durable.lease,
				runtimeGeneration: 7,
				providerSandboxId: "sandbox-1",
				nowMs: Effect.succeed(durable.lease.leaseDeadline),
				transcriptKey: durable.transcriptKey,
				storageIncarnationId: "storage-1",
				sendMessage,
				receipts: receipts.store,
			}),
		);

		expect(acknowledgment).toBeNull();
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("accepts a proven completion after an apply began within its lease", async () => {
		const durable = await makeDurableMessageLease();
		const receipts = makeReceiptStore(null);
		const sendMessage = vi.fn();

		const acknowledgment = await Effect.runPromise(
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const nowMs = yield* Clock.currentTimeMillis;
				const lease = RuntimeLease.make({
					...durable.lease,
					leaseDeadline: nowMs + 100,
				});
				sendMessage.mockImplementation(() =>
					Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
						Effect.andThen(
							Effect.sync(() => receipts.write(boundReceiptFor(durable))),
						),
					),
				);
				const fiber = yield* Effect.forkDetach(
					applyCloudMailboxLease({
						config: { workspaceId: "workspace-1" },
						lease,
						runtimeGeneration: 7,
						providerSandboxId: "sandbox-1",
						nowMs: Clock.currentTimeMillis,
						transcriptKey: durable.transcriptKey,
						storageIncarnationId: "storage-1",
						sendMessage,
						receipts: receipts.store,
					}),
				);
				yield* Deferred.await(started);
				yield* TestClock.adjust("101 millis");
				yield* Deferred.succeed(release, undefined);
				return yield* Fiber.join(fiber);
			}).pipe(Effect.provide(TestClock.layer())),
		);

		expect(acknowledgment).toMatchObject({ state: "applied" });
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});

	it("retries an unproven apply on the next consumer cycle", async () => {
		const durable = await makeDurableMessageLease();
		const lease = RuntimeLease.make({
			...durable.lease,
			leaseDeadline: Date.now() + 60_000,
		});
		const acknowledgment = RuntimeAcknowledgment.make({
			commandId: lease.command.commandId,
			leaseToken: lease.leaseToken,
			fingerprint: lease.command.fingerprint,
			state: "rejected",
			category: "session-not-found",
		});
		const state = {
			pendingApplications: new Map(),
			pendingAcknowledgments: new Map(),
		};
		let leasePolls = 0;
		let applyAttempts = 0;
		let acknowledgments = 0;
		const cycle = () =>
			runCloudMailboxConsumerCycle({
				state,
				lease: Effect.sync(() => {
					leasePolls += 1;
					return {
						leases: leasePolls === 1 ? [lease] : [],
						fenceRequired: false,
					};
				}),
				apply: () =>
					Effect.sync(() => {
						applyAttempts += 1;
						return applyAttempts === 1 ? null : acknowledgment;
					}),
				acknowledge: () =>
					Effect.sync(() => {
						acknowledgments += 1;
					}),
			});

		await Effect.runPromise(cycle());
		expect(state.pendingApplications.size).toBe(1);
		expect(acknowledgments).toBe(0);
		await Effect.runPromise(cycle());
		expect(applyAttempts).toBe(2);
		expect(state.pendingApplications.size).toBe(0);
		expect(acknowledgments).toBe(1);
	});

	it("drops permanent ACKs but retains transient ACKs without blocking polling", async () => {
		const acknowledgment = RuntimeAcknowledgment.make({
			commandId: CommandId.make("command-pending"),
			leaseToken: "lease-pending",
			fingerprint: "hmac-sha256:pending",
			state: "rejected",
			category: "runtime-apply-failed",
		});
		const permanentState = {
			pendingApplications: new Map(),
			pendingAcknowledgments: new Map([
				[acknowledgment.commandId, acknowledgment],
			]),
		};
		let permanentPolls = 0;
		let invariantFailures = 0;
		await Effect.runPromise(
			runCloudMailboxConsumerCycle({
				state: permanentState,
				lease: Effect.sync(() => {
					permanentPolls += 1;
					return { leases: [], fenceRequired: false };
				}),
				apply: () => Effect.succeed(acknowledgment),
				acknowledge: () =>
					Effect.fail(
						new CloudWorkspaceRuntimeError({
							reason: "api_http_rejected",
							httpStatus: 409,
						}),
					),
				onRuntimeFenceRequired: Effect.sync(() => {
					invariantFailures += 1;
				}),
			}),
		);
		expect(permanentPolls).toBe(1);
		expect(permanentState.pendingAcknowledgments.size).toBe(0);
		expect(invariantFailures).toBe(1);

		const transientState = {
			pendingApplications: new Map(),
			pendingAcknowledgments: new Map([
				[acknowledgment.commandId, acknowledgment],
			]),
		};
		let transientPolls = 0;
		await Effect.runPromise(
			runCloudMailboxConsumerCycle({
				state: transientState,
				lease: Effect.sync(() => {
					transientPolls += 1;
					return { leases: [], fenceRequired: false };
				}),
				apply: () => Effect.succeed(acknowledgment),
				acknowledge: () =>
					Effect.fail(
						new CloudWorkspaceRuntimeError({
							reason: "api_http_rejected",
							httpStatus: 503,
						}),
					),
			}),
		);
		expect(transientPolls).toBe(1);
		expect(transientState.pendingAcknowledgments.size).toBe(1);
		expect(
			classifyCloudMailboxAckFailure(
				new CloudWorkspaceRuntimeError({
					reason: "api_http_rejected",
					httpStatus: 404,
				}),
			),
		).toBe("stop-retrying");
		expect(
			classifyCloudMailboxAckFailure(
				new CloudWorkspaceRuntimeError({ reason: "api_invalid_response" }),
			),
		).toBe("retry");
	});

	it("requests a generation fence when an unproven apply lease expires", async () => {
		const durable = await makeDurableMessageLease();
		const expiredLease = RuntimeLease.make({
			...durable.lease,
			leaseDeadline: Date.now() - 1,
		});
		const state = {
			pendingApplications: new Map([
				[expiredLease.command.commandId, expiredLease],
			]),
			pendingAcknowledgments: new Map(),
		};
		let leasePolls = 0;
		let fenceRequests = 0;

		await Effect.runPromise(
			runCloudMailboxConsumerCycle({
				state,
				lease: Effect.sync(() => {
					leasePolls += 1;
					return { leases: [], fenceRequired: false };
				}),
				apply: () => Effect.succeed(null),
				acknowledge: () => Effect.void,
				onRuntimeFenceRequired: Effect.sync(() => {
					fenceRequests += 1;
				}),
			}),
		);

		expect(state.pendingApplications.size).toBe(0);
		expect(fenceRequests).toBe(1);
		expect(leasePolls).toBe(1);
	});

	it("requests a generation fence when the mailbox retained an expired lease", async () => {
		const state = {
			pendingApplications: new Map(),
			pendingAcknowledgments: new Map(),
		};
		let fenceRequests = 0;

		await Effect.runPromise(
			runCloudMailboxConsumerCycle({
				state,
				lease: Effect.succeed({ leases: [], fenceRequired: true }),
				apply: () => Effect.die("an empty fenced page must not apply"),
				acknowledge: () => Effect.die("an empty fenced page must not ack"),
				onRuntimeFenceRequired: Effect.sync(() => {
					fenceRequests += 1;
				}),
			}),
		);

		expect(fenceRequests).toBe(1);
	});
});
