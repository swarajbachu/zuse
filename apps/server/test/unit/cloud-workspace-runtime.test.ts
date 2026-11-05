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
	SealedCodexGrant,
	SealedProviderGrant,
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
	authorizeCloudMailboxActor,
	authorizeCloudQueuedActor,
	authorizeCloudRuntimeActor,
	authorizeCloudRuntimeAutomations,
	bufferWorkspaceLocalFrame,
	CloudMailboxApplyError,
	type CloudMailboxCommandIdentity,
	type CloudMailboxCommandReceipt,
	type CloudMailboxReceiptStore,
	CloudWorkspaceRuntimeError,
	classifyCloudMailboxAckFailure,
	cloudGatewayCloseReason,
	decodeImageProviderSecrets,
	keepCloudRuntimeActive,
	makeCloudRuntimeCheckpointPublisher,
	makeCloudRuntimeSummaryPublisher,
	makeStartupLaunchGrant,
	ProviderReadySignal,
	prepareSelectedAgentCredential,
	providerCredentialFailureIsTerminal,
	recoverCloudMailboxReadiness,
	renewRuntimeCredential,
	resolveCloudRuntimeActiveSession,
	retainedCloudRuntimeStorageFailure,
	retryableCloudGatewayFailure,
	retryCloudWorkspaceBootstrap,
	runCloudMailboxConsumerCycle,
	runCloudMailboxPolling,
	runtimeCredentialRenewalDelayMs,
	runtimeReadyPhaseOnGatewayOpen,
	signRuntimeRenewalProof,
	startCloudCodexAuth,
	startCloudWorkspaceLaunchIntent,
	trackSnapshotNativeAccess,
	writeGithubBrokerState,
} from "../../src/api/cloud-workspace-runtime.ts";

it("retries queued author checks after an outage but stops on revocation", async () => {
	const fetcher = vi
		.fn()
		.mockResolvedValueOnce(Response.json({}, { status: 503 }))
		.mockResolvedValue(Response.json({ permission: "edit" }));
	vi.stubGlobal("fetch", fetcher);
	const input = {
		config: { apiUrl: "https://api.test", workspaceId: "workspace" },
		credential: { credential: "runtime", generation: 4, gatewayEpoch: 8 },
		actor: { subject: "author", membershipId: "membership" },
	};
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const pending = yield* Effect.forkChild(
					authorizeCloudQueuedActor(input),
				);
				yield* TestClock.adjust("5 seconds");
				expect(yield* Fiber.join(pending)).toBe(true);
			}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
		);
		expect(fetcher).toHaveBeenCalledTimes(2);
		fetcher.mockResolvedValue(Response.json({}, { status: 403 }));
		expect(await Effect.runPromise(authorizeCloudQueuedActor(input))).toBe(
			false,
		);
		expect(
			await Effect.runPromise(
				authorizeCloudQueuedActor({ ...input, actor: undefined }),
			),
		).toBe(false);
		expect(fetcher).toHaveBeenCalledTimes(3);
	} finally {
		vi.unstubAllGlobals();
	}
});

it("checks mailbox authors and distinguishes revocation from provider outages", async () => {
	const fetcher = vi.fn();
	vi.stubGlobal("fetch", fetcher);
	const input = {
		config: { apiUrl: "https://api.test", workspaceId: "workspace" },
		credential: { credential: "runtime", generation: 4, gatewayEpoch: 8 },
		actor: { subject: "member", membershipId: "original-membership" },
	};
	try {
		await expect(
			Effect.runPromise(
				authorizeCloudMailboxActor({ ...input, actor: undefined }),
			),
		).rejects.toMatchObject({ category: "command-author-access-denied" });
		expect(fetcher).not.toHaveBeenCalled();
		fetcher.mockResolvedValue(Response.json({ permission: "edit" }));
		await Effect.runPromise(authorizeCloudMailboxActor(input));
		expect(JSON.parse(fetcher.mock.calls[0]?.[1].body)).toEqual({
			actorId: "member",
			membershipId: "original-membership",
			runtimeGeneration: 4,
			gatewayEpoch: 8,
		});
		for (const [status, permission, category] of [
			[200, "view", "command-author-access-denied"],
			[403, "edit", "command-author-access-denied"],
			[503, "edit", "command-author-access-unavailable"],
			[401, "edit", "command-author-access-unavailable"],
		] as const) {
			fetcher.mockResolvedValue(Response.json({ permission }, { status }));
			await expect(
				Effect.runPromise(authorizeCloudMailboxActor(input)),
			).rejects.toMatchObject({ category });
		}
	} finally {
		vi.unstubAllGlobals();
	}
});

it("revalidates gateway authority with renewed credentials and never exceeds a View ticket", async () => {
	let permission = "edit";
	let status = 200;
	const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
		Response.json({ permission }, { status }),
	);
	vi.stubGlobal("fetch", fetcher);
	try {
		const credential = {
			credential: "runtime-1",
			generation: 4,
			gatewayEpoch: 8,
		};
		const input = {
			config: { apiUrl: "https://api.test", workspaceId: "workspace" },
			credential,
			actorId: "member",
			membershipId: "original-membership",
			permission: "view" as const,
		};
		const view = authorizeCloudRuntimeActor(input);
		expect(await Effect.runPromise(view)).toBe("view");
		expect(fetcher.mock.calls[0]?.[0]).toBe(
			"https://api.test/v1/cloud/workspaces/workspace/runtime/access",
		);
		credential.credential = "runtime-renewed";
		permission = "view";
		expect(
			await Effect.runPromise(
				authorizeCloudRuntimeActor({ ...input, permission: "edit" }),
			),
		).toBe("view");
		expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
			headers: { authorization: "Bearer runtime-renewed" },
			body: JSON.stringify({
				actorId: "member",
				membershipId: "original-membership",
				runtimeGeneration: 4,
				gatewayEpoch: 8,
			}),
		});
		status = 403;
		await expect(Effect.runPromise(view)).rejects.toMatchObject({
			_tag: "RpcAccessDeniedError",
		});
		status = 503;
		await expect(Effect.runPromise(view)).rejects.toMatchObject({
			_tag: "RpcAccessDeniedError",
		});
		status = 200;
		permission = "owner";
		await expect(Effect.runPromise(view)).rejects.toMatchObject({
			_tag: "RpcAccessDeniedError",
		});
	} finally {
		vi.unstubAllGlobals();
	}
});

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
				actor: input.lease.command.actor,
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

	it("keeps a complete checkpoint readable until the next history publication", async () => {
		const sessionId = AgentSessionId.make("session-pages");
		const older = Message.make({
			id: MessageId.make("message-older"),
			sessionId,
			role: "assistant",
			content: { _tag: "assistant", text: "older durable output" },
			createdAt: new Date(1),
		});
		let version = 9;
		const headWrites: unknown[] = [];
		const pageWrites: Array<{ readonly beforeSequence: number }> = [];
		const publisher = await Effect.runPromise(
			makeCloudRuntimeCheckpointPublisher({
				workspaceId: "workspace-pages",
				sessionId,
				transcriptKey: bytesToBase64Url(new Uint8Array(32).fill(7)),
				read: Effect.sync(() => ({
					cursor: { epoch: "epoch-pages", version },
					projection: SessionTimelineProjection.make({
						messages: [],
						olderMessageSequence: 20,
						status: "idle",
						activeTurn: null,
						turnCount: 0,
						queue: QueueState.make({ items: [], paused: false }),
						permissionMode: "default",
						runtimeMode: "approval-required",
					}),
				})),
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
		version = 10;
		publisher.mark();
		expect(await Effect.runPromise(publisher.flush)).toBe(false);
		expect(headWrites).toHaveLength(1);
		publisher.mark(true);
		expect(await Effect.runPromise(publisher.flush)).toBe(true);
		expect(headWrites).toHaveLength(2);
		expect(pageWrites).toHaveLength(2);
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
					lastUserMessageAt: 500,
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
				lastUserMessageAt: 500,
				activeSessionId: "session-1",
				sessionHeadVersion: 4,
			},
			{
				summaryRevision: 2,
				title: "Renamed immediately",
				lastActivityAt: 2_000,
				lastUserMessageAt: 500,
				activeSessionId: "session-1",
				sessionHeadVersion: 7,
			},
			{
				summaryRevision: 3,
				title: "Renamed immediately",
				lastActivityAt: 2_000,
				lastUserMessageAt: 500,
				activeSessionId: "session-1",
				sessionHeadVersion: 7,
			},
		]);
		for (const summary of writes) {
			expect(summary).not.toHaveProperty("content");
			expect(summary).not.toHaveProperty("messages");
		}
	});

	it("publishes session recovery even immediately after an activity update", async () => {
		let ready = false;
		let sessionRecovered = false;
		const publisher = await Effect.runPromise(
			makeCloudRuntimeSummaryPublisher({
				now: Effect.succeed(1000),
				read: Effect.succeed({
					title: "Recovered",
					lastActivityAt: 1000,
					activeSessionId: SessionId.make("session-1"),
					sessionHeadVersion: 195,
				}),
				write: (summary) =>
					Effect.sync(() => {
						if (ready) sessionRecovered = true;
						return { applied: true, summaryRevision: summary.summaryRevision };
					}),
			}),
		);
		await Effect.runPromise(publisher.publish("activity"));
		const lease = Effect.suspend(() =>
			sessionRecovered
				? Effect.succeed("leased")
				: Effect.fail(
						new CloudWorkspaceRuntimeError({
							reason: "cloud_workspace_runtime_not_ready",
						}),
					),
		);
		const result = await Effect.runPromise(
			recoverCloudMailboxReadiness(
				lease,
				Effect.sync(() => {
					ready = true;
				}).pipe(Effect.andThen(publisher.publish("recovery")), Effect.asVoid),
			),
		);
		expect(result).toBe("leased");
		expect(sessionRecovered).toBe(true);
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

	it("rejects an empty replacement runtime before announcing retained readiness", () => {
		expect(retainedCloudRuntimeStorageFailure(false, false)).toBe(
			"runtime-storage-replaced",
		);
		expect(retainedCloudRuntimeStorageFailure(false, true)).toBeNull();
		expect(retainedCloudRuntimeStorageFailure(true, false)).toBeNull();
	});

	it("announces readiness when a preserved runtime reconnects", () => {
		expect(runtimeReadyPhaseOnGatewayOpen(false)).toBe("runtime-connected");
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

	it("reauthenticates an expired preserved runtime after sleep without changing its generation", async () => {
		const runtimeData = await mkdtemp(join(tmpdir(), "zuse-runtime-renew-"));
		vi.stubEnv("ZUSE_USER_DATA", runtimeData);
		const keys = await generateKeyPair("EdDSA", { extractable: true });
		const state = {
			credential: "expired-credential",
			expiresAt: Date.now() - 2 * 24 * 60 * 60_000,
			generation: 4,
			gatewayEpoch: 7,
		};
		const expiresAt = Date.now() + 15 * 60_000;
		const fetcher = vi.fn().mockResolvedValue(
			Response.json({
				workspaceId: "workspace-1",
				requestId: "renewal-after-sleep",
				runtimeCredential: "fresh-credential",
				expiresAt,
				generation: 4,
				gatewayEpoch: 7,
			}),
		);
		vi.stubGlobal("fetch", fetcher);
		try {
			await Effect.runPromise(
				renewRuntimeCredential({
					config: {
						workspaceId: "workspace-1",
						apiUrl: "https://api.test",
						bootToken: Redacted.make("consumed-boot-token"),
						localPort: 47837,
						workspaceRoot: "/repos/example",
					},
					signingPrivateKey: keys.privateKey,
					state,
					requestId: "renewal-after-sleep",
				}),
			);
			expect(fetcher).toHaveBeenCalledTimes(1);
			const request = fetcher.mock.calls[0]?.[1];
			const body = JSON.parse(request.body);
			const proof = await jwtVerify(body.proof, keys.publicKey, {
				audience: "https://api.test",
			});
			expect(proof.payload).toMatchObject({
				generation: 4,
				gatewayEpoch: 7,
				requestId: "renewal-after-sleep",
			});
			expect(state).toMatchObject({
				credential: "fresh-credential",
				expiresAt,
				generation: 4,
				gatewayEpoch: 7,
			});
		} finally {
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
			await rm(runtimeData, { recursive: true, force: true });
		}
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

	it("keeps renewing through an authority outage longer than the access lifetime", async () => {
		const runtimeData = await mkdtemp(
			join(tmpdir(), "zuse-runtime-renew-outage-"),
		);
		vi.stubEnv("ZUSE_USER_DATA", runtimeData);
		const keys = await generateKeyPair("EdDSA", { extractable: true });
		const config = {
			workspaceId: "workspace-1",
			apiUrl: "https://api.test",
			bootToken: Redacted.make("boot"),
			localPort: 47837,
			workspaceRoot: "/repos/example",
		};
		const state = {
			credential: "old",
			expiresAt: 1000,
			generation: 4,
			gatewayEpoch: 7,
		};
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					let nowMs = 0;
					const liveClock = yield* Clock.Clock;
					const fetcher = vi
						.fn()
						.mockImplementationOnce(async () => {
							nowMs = 2 * 24 * 60 * 60_000;
							return Response.json({}, { status: 503 });
						})
						.mockResolvedValue(
							Response.json({
								workspaceId: "workspace-1",
								requestId: "same-request",
								runtimeCredential: "fresh",
								expiresAt: 2 * 24 * 60 * 60_000 + 10_000,
								generation: 4,
								gatewayEpoch: 7,
							}),
						);
					vi.stubGlobal("fetch", fetcher);
					yield* renewRuntimeCredential({
						config,
						signingPrivateKey: keys.privateKey,
						state,
						requestId: "same-request",
					}).pipe(
						Effect.provideService(Clock.Clock, {
							currentTimeNanosUnsafe: () => liveClock.currentTimeNanosUnsafe(),
							currentTimeNanos: liveClock.currentTimeNanos,
							sleep: (duration) => liveClock.sleep(duration),
							currentTimeMillisUnsafe: () => nowMs,
							currentTimeMillis: Effect.sync(() => nowMs),
						}),
					);
					expect(state).toMatchObject({
						credential: "fresh",
						generation: 4,
					});
					expect(fetcher).toHaveBeenCalledTimes(2);
					for (const call of fetcher.mock.calls)
						expect(JSON.parse(call[1].body).requestId).toBe("same-request");
				}),
			);
		} finally {
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
			await rm(runtimeData, { recursive: true, force: true });
		}
	});

	it("retries an expired gateway authorization without retrying a replaced generation", () => {
		expect(
			retryableCloudGatewayFailure(
				new CloudWorkspaceRuntimeError({
					reason: "workspace_gateway_authorization_expired",
				}),
			),
		).toBe(true);
		expect(
			retryableCloudGatewayFailure(
				new CloudWorkspaceRuntimeError({
					reason: "workspace_gateway_generation_changed",
				}),
			),
		).toBe(false);
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

	it("launches a machine fork from the retained database with stable target identities", async () => {
		const forkSession = vi.fn(() =>
			Effect.succeed({ chat: {}, session: {}, forkMode: "resume" }),
		);
		const createChat = vi.fn();
		await Effect.runPromise(
			startCloudWorkspaceLaunchIntent({
				workspaces: {
					list: () => Effect.succeed([{ id: "folder", path: "/repo" }]),
				} as never,
				chats: { createChat } as never,
				transcripts: { forkSession } as never,
				workspaceId: "child",
				chatId: "new-chat",
				sessionId: "new-session",
				workspaceRoot: "/repo",
				launchIntent: {
					commandId: "launch:child",
					turnId: "turn:child",
					title: "Fork",
					agent: "codex",
					model: "gpt-5",
					permissions: [],
					forkSource: {
						chatId: "source-chat",
						sessionId: "source-session",
						messageId: "point",
					},
				},
			}),
		);
		expect(createChat).not.toHaveBeenCalled();
		expect(forkSession).toHaveBeenCalledWith({
			sourceSessionId: "source-session",
			fromMessageId: "point",
			destination: "chat",
			chatId: "new-chat",
			initialSessionId: "new-session",
			commandId: "launch:child",
			sourceSnapshot: {
				databasePath: "/var/lib/zuse/fork-source/child/user-data/zuse.sqlite",
				chatId: "source-chat",
				projectId: "folder",
			},
		});
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

	it.each([
		["command-author-access-denied", false],
		["command-author-access-unavailable", false],
		["command-author-access-denied", true],
	] as const)("handles author validation %s with committed=%s without sending again", async (category, committed) => {
		const durable = await makeDurableMessageLease();
		const receipts = makeReceiptStore(
			committed ? boundReceiptFor(durable) : null,
		);
		const sendMessage = vi.fn(() => Effect.void);
		const authorizeActor = vi.fn(() =>
			Effect.fail(new CloudMailboxApplyError({ category })),
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
				authorizeActor,
			}),
		);
		expect(sendMessage).not.toHaveBeenCalled();
		expect(authorizeActor).toHaveBeenCalledTimes(committed ? 0 : 1);
		if (committed) expect(acknowledgment).toMatchObject({ state: "applied" });
		else if (category === "command-author-access-unavailable")
			expect(acknowledgment).toBeNull();
		else expect(acknowledgment).toMatchObject({ state: "rejected", category });
	});

	it.each([
		true,
		false,
	])("binds recovered receipts to the original author (matching=%s)", async (matching) => {
		const durable = await makeDurableMessageLease();
		const actor = { subject: "author", membershipId: "original-membership" };
		const attributed = {
			...durable,
			lease: { ...durable.lease, command: { ...durable.lease.command, actor } },
		};
		const receipts = makeReceiptStore(boundReceiptFor(attributed));
		const sendMessage = vi.fn(() => Effect.void);
		const acknowledgment = await Effect.runPromise(
			applyCloudMailboxLease({
				config: { workspaceId: "workspace-1" },
				lease: {
					...attributed.lease,
					command: {
						...attributed.lease.command,
						actor: matching
							? actor
							: { ...actor, membershipId: "rejoined-membership" },
					},
				},
				runtimeGeneration: 7,
				providerSandboxId: "sandbox-1",
				nowMs: Effect.succeed(1),
				transcriptKey: durable.transcriptKey,
				storageIncarnationId: "storage-1",
				sendMessage,
				receipts: receipts.store,
			}),
		);
		expect(acknowledgment).toMatchObject(
			matching
				? { state: "applied" }
				: { state: "outcome-unknown", category: "runtime-receipt-invalid" },
		);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("acknowledges a new message only after its receipt is persisted", async () => {
		const original = await makeDurableMessageLease();
		const actor = { subject: "author", membershipId: "original-membership" };
		const durable = {
			...original,
			lease: {
				...original.lease,
				command: { ...original.lease.command, actor },
			},
		};
		const receipts = makeReceiptStore(null);
		const sendMessage = vi.fn(
			(
				..._args: Parameters<
					Parameters<typeof applyCloudMailboxLease>[0]["sendMessage"]
				>
			) => Effect.sync(() => receipts.write(boundReceiptFor(durable))),
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
		expect(sendMessage.mock.calls[0]?.[11]).toEqual(actor);
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

	it("reports a pre-commit active-turn conflict as rejected, not ambiguous", async () => {
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
					Effect.die({ _tag: "TurnAlreadyRunning", turnId: "existing-turn" }),
				receipts: receipts.store,
			}),
		);

		expect(acknowledgment).toMatchObject({
			state: "rejected",
			category: "session-turn-active",
		});
		expect(JSON.stringify(acknowledgment)).not.toContain("Bearer");
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

describe("preserved runtime mailbox readiness", () => {
	it("republishes readiness and retries the lease once", async () => {
		const events: string[] = [];
		let attempts = 0;
		const lease = Effect.suspend(() => {
			events.push("lease");
			return ++attempts === 1
				? Effect.fail(
						new CloudWorkspaceRuntimeError({
							reason: "cloud_workspace_runtime_not_ready",
						}),
					)
				: Effect.succeed("delivered");
		});
		expect(
			await Effect.runPromise(
				recoverCloudMailboxReadiness(
					lease,
					Effect.sync(() => {
						events.push("ready");
					}),
				),
			),
		).toBe("delivered");
		expect(events).toEqual(["lease", "ready", "lease"]);
	});
	it("never repairs a rejected credential or repeatedly retries a not-ready lease", async () => {
		for (const reason of [
			"workspace_runtime_rejected",
			"cloud_workspace_runtime_not_ready",
		]) {
			let attempts = 0;
			let repairs = 0;
			const lease = Effect.suspend(() => {
				attempts++;
				return Effect.fail(new CloudWorkspaceRuntimeError({ reason }));
			});
			const result = await Effect.runPromise(
				recoverCloudMailboxReadiness(
					lease,
					Effect.sync(() => {
						repairs++;
					}),
				).pipe(Effect.result),
			);
			expect(result._tag).toBe("Failure");
			expect(attempts).toBe(reason === "workspace_runtime_rejected" ? 1 : 2);
			expect(repairs).toBe(reason === "workspace_runtime_rejected" ? 0 : 1);
		}
	});
	it("does not lease when the API refuses readiness", async () => {
		let attempts = 0;
		const result = await Effect.runPromise(
			recoverCloudMailboxReadiness(
				Effect.suspend(() => {
					attempts++;
					return Effect.fail(
						new CloudWorkspaceRuntimeError({
							reason: "cloud_workspace_runtime_not_ready",
						}),
					);
				}),
				Effect.fail(
					new CloudWorkspaceRuntimeError({
						reason: "workspace_runtime_rejected",
					}),
				),
			).pipe(Effect.result),
		);
		expect(result).toMatchObject({
			_tag: "Failure",
			failure: { reason: "workspace_runtime_rejected" },
		});
		expect(attempts).toBe(1);
	});
});

describe("cloud active work keepalive", () => {
	it("keeps a quiet turn alive, stops when idle, and survives a failed update", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const chatId = ChatId.make("quiet-chat");
				let active = true;
				let attempts = 0;
				const fiber = yield* Effect.forkScoped(
					keepCloudRuntimeActive({
						chatId,
						sessions: Effect.sync(() => [
							{
								id: SessionId.make("quiet-session"),
								chatId,
								status: active ? ("running" as const) : ("idle" as const),
							},
							{
								id: SessionId.make("other-session"),
								chatId: ChatId.make("other-chat"),
								status: "running" as const,
							},
						]),
						publish: Effect.suspend(() =>
							++attempts === 1 ? Effect.fail("network") : Effect.void,
						),
					}),
				);
				yield* Effect.yieldNow;
				expect(attempts).toBe(1);
				yield* TestClock.adjust("11 minutes");
				expect(attempts).toBeGreaterThan(20);
				active = false;
				const beforeIdle = attempts;
				yield* TestClock.adjust("2 minutes");
				expect(attempts).toBe(beforeIdle);
				yield* Fiber.interrupt(fiber);
			}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
		);
	});
});

it.each([
	"sessions",
	"inputs",
	"publish",
] as const)("keeps active work protected after a %s defect and stops on shutdown", async (stage) => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const chatId = ChatId.make("keepalive-defect-chat");
			let failed = false;
			let published = 0;
			const probe = (at: typeof stage) =>
				Effect.suspend(() => {
					if (stage === at && !failed) {
						failed = true;
						return Effect.die(new Error("transient read failure"));
					}
					return Effect.void;
				});
			const fiber = yield* Effect.forkScoped(
				keepCloudRuntimeActive({
					chatId,
					sessions: probe("sessions").pipe(
						Effect.as([
							{
								id: SessionId.make("keepalive-defect-session"),
								chatId,
								status: "running" as const,
							},
						]),
					),
					isWaitingForInput: () => probe("inputs").pipe(Effect.as(false)),
					publish: probe("publish").pipe(
						Effect.andThen(
							Effect.sync(() => {
								published++;
							}),
						),
					),
				}),
			);
			yield* TestClock.adjust("11 minutes");
			expect(failed).toBe(true);
			expect(published).toBeGreaterThan(20);
			yield* Fiber.interrupt(fiber);
			const stopped = published;
			yield* TestClock.adjust("1 minute");
			expect(published).toBe(stopped);
		}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
	);
});

describe("cloud mailbox polling lifetime", () => {
	it("preserves the runtime through ambiguous credential rejection without minting wake intent", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				let attempts = 0;
				let stopped = 0;
				const fiber = yield* Effect.forkScoped(
					runCloudMailboxPolling({
						poll: Effect.suspend(() => {
							attempts++;
							return Effect.fail(
								new CloudWorkspaceRuntimeError({
									reason: "workspace_runtime_rejected",
									httpStatus: 401,
								}),
							);
						}),
						interval: "1 second",
						onRuntimeRejected: Effect.sync(() => {
							stopped++;
						}),
					}),
				);
				yield* TestClock.adjust("30 seconds");
				expect(stopped).toBe(0);
				yield* TestClock.adjust("40 seconds");
				expect(stopped).toBe(0);
				const beforeRetry = attempts;
				yield* TestClock.adjust("1 minute");
				expect(attempts).toBeGreaterThan(beforeRetry);
				yield* Fiber.interrupt(fiber);
			}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
		);
	});
});

it("does not keep approval-blocked turns alive and resumes keepalive after a decision", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const chatId = ChatId.make("approval-chat");
			let waiting = true;
			let attempts = 0;
			const fiber = yield* Effect.forkScoped(
				keepCloudRuntimeActive({
					chatId,
					sessions: Effect.succeed([
						{
							id: SessionId.make("approval-session"),
							chatId,
							status: "running" as const,
						},
					]),
					isWaitingForInput: () => Effect.sync(() => waiting),
					publish: Effect.sync(() => {
						attempts++;
					}),
				}),
			);
			yield* TestClock.adjust("11 minutes");
			expect(attempts).toBe(0);
			waiting = false;
			yield* TestClock.adjust("1 minute");
			expect(attempts).toBeGreaterThan(0);
			yield* Fiber.interrupt(fiber);
		}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
	);
});

it("retries mailbox outages and in-flight credential rotation without retiring a live runtime", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			let attempts = 0;
			let stopped = 0;
			const fiber = yield* Effect.forkScoped(
				runCloudMailboxPolling({
					interval: "1 second",
					onRuntimeRejected: Effect.sync(() => {
						stopped++;
					}),
					poll: Effect.suspend(() => {
						attempts++;
						if (attempts === 1) {
							return Effect.fail(
								new CloudWorkspaceRuntimeError({
									reason: "workspace_runtime_rejected",
									httpStatus: 401,
								}),
							);
						}
						if (attempts === 2)
							return Effect.fail(
								new CloudWorkspaceRuntimeError({
									reason: "api_http_rejected",
									httpStatus: 503,
								}),
							);
						return Effect.void;
					}),
				}),
			);
			yield* TestClock.adjust("10 seconds");
			expect(attempts).toBeGreaterThan(3);
			expect(stopped).toBe(0);
			yield* Fiber.interrupt(fiber);
		}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
	);
});

it("does not combine credential rejections across successful mailbox polls", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			let attempts = 0;
			let stopped = 0;
			const fiber = yield* Effect.forkScoped(
				runCloudMailboxPolling({
					interval: "1 second",
					onRuntimeRejected: Effect.sync(() => {
						stopped++;
					}),
					poll: Effect.suspend(() =>
						++attempts % 3 === 0
							? Effect.void
							: Effect.fail(
									new CloudWorkspaceRuntimeError({
										reason: "workspace_runtime_rejected",
										httpStatus: 401,
									}),
								),
					),
				}),
			);
			yield* TestClock.adjust("10 seconds");
			expect(attempts).toBeGreaterThan(3);
			expect(stopped).toBe(0);
			yield* Fiber.interrupt(fiber);
		}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
	);
});

it.each([
	403, 404,
])("does not infer owner revocation from generic HTTP %s", async (httpStatus) => {
	await Effect.runPromise(
		Effect.gen(function* () {
			let attempts = 0;
			let stopped = 0;
			const fiber = yield* Effect.forkScoped(
				runCloudMailboxPolling({
					interval: "1 second",
					onRuntimeRejected: Effect.sync(() => {
						stopped++;
					}),
					poll: Effect.suspend(() => {
						attempts++;
						return Effect.fail(
							new CloudWorkspaceRuntimeError({
								reason: "api_http_rejected",
								httpStatus,
							}),
						);
					}),
				}),
			);
			yield* TestClock.adjust("10 seconds");
			expect(attempts).toBeGreaterThan(1);
			expect(stopped).toBe(0);
			yield* Fiber.interrupt(fiber);
		}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
	);
});

it.each([
	"workspace_runtime_rejected",
	"workspace_runtime_fenced",
])("mailbox distinguishes reauthentication from confirmed fencing (%s)", async (reason) => {
	await Effect.runPromise(
		Effect.gen(function* () {
			let stopped = 0;
			const fiber = yield* Effect.forkScoped(
				runCloudMailboxPolling({
					interval: "1 second",
					onRuntimeRejected: Effect.sync(() => {
						stopped++;
					}),
					poll: Effect.fail(
						new CloudWorkspaceRuntimeError({ reason, httpStatus: 401 }),
					),
				}),
			);
			yield* TestClock.adjust("2 minutes");
			expect(stopped).toBe(reason === "workspace_runtime_fenced" ? 1 : 0);
			yield* Fiber.interrupt(fiber);
		}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
	);
});

it("allows delayed credential renewal before retiring repeated authorization rejection", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			let credential = "old-credential";
			let attempts = 0;
			let stopped = 0;
			const fiber = yield* Effect.forkScoped(
				runCloudMailboxPolling({
					interval: "1 second",
					onRuntimeRejected: Effect.sync(() => {
						stopped++;
					}),
					poll: Effect.suspend(() => {
						attempts++;
						return credential === "old-credential"
							? Effect.fail(
									new CloudWorkspaceRuntimeError({
										reason: "workspace_runtime_rejected",
										httpStatus: 401,
									}),
								)
							: Effect.void;
					}),
				}),
			);
			yield* TestClock.adjust("45 seconds");
			expect(stopped).toBe(0);
			credential = "renewed-credential";
			yield* TestClock.adjust("1 minute");
			expect(stopped).toBe(0);
			expect(attempts).toBeGreaterThan(60);
			yield* Fiber.interrupt(fiber);
		}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
	);
});

it("retains execution when ambiguous rejection alternates with network outages", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			let attempts = 0;
			let stopped = 0;
			const fiber = yield* Effect.forkScoped(
				runCloudMailboxPolling({
					interval: "1 second",
					onRuntimeRejected: Effect.sync(() => {
						stopped++;
					}),
					poll: Effect.suspend(() => {
						attempts++;
						return Effect.fail(
							new CloudWorkspaceRuntimeError(
								attempts % 2 === 0
									? { reason: "api_request_failed" }
									: { reason: "workspace_runtime_rejected", httpStatus: 401 },
							),
						);
					}),
				}),
			);
			yield* TestClock.adjust("70 seconds");
			expect(stopped).toBe(0);
			const retiredAttempts = attempts;
			yield* TestClock.adjust("1 minute");
			expect(attempts).toBeGreaterThan(retiredAttempts);
			yield* Fiber.interrupt(fiber);
		}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
	);
});

it.each([
	"workspace_summary_publish_failed",
	"workspace_readiness_publish_failed",
])("retries status-less readiness recovery failure %s without retiring the runtime", async (reason) => {
	await Effect.runPromise(
		Effect.gen(function* () {
			let leases = 0;
			let repairs = 0;
			let stopped = 0;
			const lease = Effect.suspend(() => {
				leases++;
				return repairs < 2
					? Effect.fail(
							new CloudWorkspaceRuntimeError({
								reason: "cloud_workspace_runtime_not_ready",
								httpStatus: 409,
							}),
						)
					: Effect.void;
			});
			const fiber = yield* Effect.forkScoped(
				runCloudMailboxPolling({
					interval: "1 second",
					onRuntimeRejected: Effect.sync(() => {
						stopped++;
					}),
					poll: recoverCloudMailboxReadiness(
						lease,
						Effect.suspend(() => {
							repairs++;
							return Effect.fail(new CloudWorkspaceRuntimeError({ reason }));
						}),
					),
				}),
			);
			yield* TestClock.adjust("70 seconds");
			expect(stopped).toBe(0);
			expect(repairs).toBe(2);
			expect(leases).toBeGreaterThan(2);
			yield* Fiber.interrupt(fiber);
		}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
	);
});

it.each([
	"session",
	"history",
])("native %s lookup failure does not stop subsequent events", async (failure) => {
	const access = new Map();
	const session = { id: AgentSessionId.make("session"), providerId: "codex" };
	await Effect.runPromise(
		Effect.gen(function* () {
			yield* trackSnapshotNativeAccess({
				session:
					failure === "session"
						? Effect.fail("lookup failed")
						: Effect.succeed(session),
				history: () => Effect.fail("history failed"),
				outcome: "error",
				access,
			});
			expect(access.size).toBe(0);
			yield* trackSnapshotNativeAccess({
				session: Effect.succeed(session),
				history: () => Effect.succeed([]),
				outcome: "completed",
				access,
			});
		}),
	);
	expect(access.get("codex")?.state).toBe("verified");
});

describe("launch agent credential readiness", () => {
	const failure = (reason: string) =>
		Effect.fail(new CloudWorkspaceRuntimeError({ reason }));

	it("is ready immediately for agents without cloud-managed credentials", async () => {
		const prepare = vi.fn(() => Effect.never);
		const recovery = new ProviderReadySignal();
		for (const agent of ["gemini", "acp-custom", undefined]) {
			expect(
				await Effect.runPromise(
					prepareSelectedAgentCredential({
						workspaceId: "workspace-1",
						agent,
						prepare,
						recovery,
					}),
				),
			).toBeNull();
		}
		expect(prepare).not.toHaveBeenCalled();
	});

	it("prepares exactly the selected agent once", async () => {
		const prepare = vi.fn((_: string) => Effect.void);
		const selected = await Effect.runPromise(
			prepareSelectedAgentCredential({
				workspaceId: "workspace-1",
				runtimeGeneration: 4,
				agent: "claude",
				prepare,
				recovery: new ProviderReadySignal(),
			}),
		);
		expect(selected).toBe("claude");
		expect(prepare.mock.calls).toEqual([["claude"]]);
	});

	it("keeps waiting through a refused grant until that provider recovers", async () => {
		const recovery = new ProviderReadySignal();
		const onUnavailable = vi.fn(() => Effect.void);
		let attempts = 0;
		const prepare = vi.fn((_: string) => {
			attempts += 1;
			return attempts === 1
				? failure("claude-auth-reconnect-required")
				: Effect.void;
		});
		const selected = await Effect.runPromise(
			Effect.gen(function* () {
				const fiber = yield* prepareSelectedAgentCredential({
					workspaceId: "workspace-1",
					agent: "claude",
					prepare,
					recovery,
					onUnavailable,
				}).pipe(Effect.forkScoped({ startImmediately: true }));
				yield* TestClock.adjust("10 minutes");

				expect(fiber.pollUnsafe()).toBeUndefined();
				expect(attempts).toBe(1);
				expect(onUnavailable).toHaveBeenCalledWith("claude");

				recovery.notify("cursor");
				yield* TestClock.adjust("1 second");
				expect(fiber.pollUnsafe()).toBeUndefined();
				recovery.notify("claude");
				return yield* Fiber.join(fiber);
			}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
		);
		expect(selected).toBe("claude");
		expect(attempts).toBe(2);
	});

	it("does not miss a recovery that lands while the failed attempt settles", async () => {
		const recovery = new ProviderReadySignal();
		let attempts = 0;
		const prepare = vi.fn((_: string) => {
			attempts += 1;
			if (attempts === 1) {
				recovery.notify("codex");
				return failure("codex-auth-reconnecting");
			}
			return Effect.void;
		});
		expect(
			await Effect.runPromise(
				prepareSelectedAgentCredential({
					workspaceId: "workspace-1",
					agent: "codex",
					prepare,
					recovery,
				}),
			),
		).toBe("codex");
		expect(attempts).toBe(2);
	});

	it.each([
		"authentication-required",
		"expired",
		"unavailable",
	])("keeps snapshot workspaces accessible when native access is %s", async (state) => {
		await expect(
			Effect.runPromise(
				prepareSelectedAgentCredential({
					workspaceId: "workspace-1",
					agent: "claude",
					prepare: () => failure(`claude-snapshot-${state}`),
					recovery: new ProviderReadySignal(),
				}),
			),
		).resolves.toBe("claude");
	});

	it("fails the launch for a credential this runtime can never obtain", async () => {
		await expect(
			Effect.runPromise(
				prepareSelectedAgentCredential({
					workspaceId: "workspace-1",
					agent: "codex",
					prepare: () => failure("codex-auth-update-required"),
					recovery: new ProviderReadySignal(),
				}),
			),
		).rejects.toMatchObject({ reason: "codex-auth-update-required" });
		expect(
			providerCredentialFailureIsTerminal("provider-auth-legacy-workspace"),
		).toBe(true);

		expect(
			providerCredentialFailureIsTerminal("claude-snapshot-missing-tool"),
		).toBe(true);
		expect(
			providerCredentialFailureIsTerminal("claude-auth-reconnect-required"),
		).toBe(false);
		expect(
			providerCredentialFailureIsTerminal("provider-auth-reconnecting"),
		).toBe(false);
	});
});

describe("bootstrap launch grant startup identity", () => {
	const sealed = {
		protocolVersion: 1 as const,
		requestId: "550e8400-e29b-41d4-a716-446655440000",
		keyThumbprint: "thumb",
		authorityIncarnationId: "incarnation",
		authorityEpoch: 1,
		wrappedKey: "w",
		iv: "i",
		ciphertext: "c",
		tag: "t",
	};
	const providerGrant = new SealedProviderGrant({
		...sealed,
		providerId: "claude",
	});
	const codexGrant = new SealedCodexGrant(sealed);
	const thumbprint = Promise.resolve("thumb");
	const make = (
		agent: string | undefined,
		sealedGrant: SealedProviderGrant | SealedCodexGrant | undefined,
		freshBootstrap = true,
	) =>
		makeStartupLaunchGrant({
			freshBootstrap,
			workspaceId: "workspace-1",
			runtimeGeneration: 4,
			agent,
			sealed: sealedGrant,
		});

	it("seeds only the selected agent's grant and hands out no startup id afterwards", async () => {
		const seeded: string[] = [];
		const seed = (grant: SealedProviderGrant | SealedCodexGrant) => {
			seeded.push(
				grant instanceof SealedProviderGrant ? grant.providerId : "codex",
			);
			return Promise.resolve();
		};
		const claude = make("claude", providerGrant);
		expect(await Effect.runPromise(claude.seed(seed))).toBe(true);
		expect(
			await Effect.runPromise(claude.requestId("claude", thumbprint)),
		).toBeUndefined();
		const mismatched = make("codex", providerGrant);
		expect(await Effect.runPromise(mismatched.seed(seed))).toBe(false);
		const codex = make("codex", codexGrant);
		expect(await Effect.runPromise(codex.seed(seed))).toBe(true);
		expect(seeded).toEqual(["claude", "codex"]);
	});

	it("uses the deterministic startup id exactly once when bootstrap sent no grant", async () => {
		const absent = make("claude", undefined);
		const first = await Effect.runPromise(
			absent.requestId("claude", thumbprint),
		);
		expect(first).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
		);

		expect(
			await Effect.runPromise(absent.requestId("claude", thumbprint)),
		).toBeUndefined();

		expect(
			await Effect.runPromise(
				make("claude", undefined).requestId("codex", thumbprint),
			),
		).toBeUndefined();
	});

	it.each([
		"claude",
		"codex",
	] as const)("does not replay a persisted bootstrap request for %s after restart", async (agent) => {
		const initial = make(agent, undefined);
		expect(
			await Effect.runPromise(initial.requestId(agent, thumbprint)),
		).toBeDefined();
		const restarted = make(agent, undefined, false);
		expect(
			await Effect.runPromise(restarted.requestId(agent, thumbprint)),
		).toBeUndefined();
	});

	it("never reuses the startup id after a rejected seed, so a bad cached grant is not read again", async () => {
		const rejected = make("claude", providerGrant);
		expect(
			await Effect.runPromise(
				rejected.seed(() =>
					Promise.reject(new Error("claude-auth-update-required")),
				),
			),
		).toBe(false);
		expect(
			await Effect.runPromise(rejected.requestId("claude", thumbprint)),
		).toBeUndefined();
	});

	it("forwards the startup id to the first Codex initializer only", async () => {
		const initializations: Array<string | undefined> = [];
		const auth = {
			initialize: async (requestId?: string) => {
				initializations.push(requestId);
			},
			close: () => {},
			getTokens: async () => ({
				accessToken: "test",
				chatgptAccountId: "account",
				chatgptPlanType: null,
				expiresAt: Date.now() + 60_000,
			}),
			onDeliveryFailure: () => {},
		};
		await Effect.runPromise(
			Effect.gen(function* () {
				const startup = make("codex", undefined);
				yield* startCloudCodexAuth(
					"workspace-1",
					auth,
					Effect.void,
					yield* startup.requestId("codex", thumbprint),
				);
				const seededStartup = make("codex", codexGrant);
				yield* seededStartup.seed(() => Promise.resolve());
				yield* startCloudCodexAuth(
					"workspace-1",
					auth,
					Effect.void,
					yield* seededStartup.requestId("codex", thumbprint),
				);
			}).pipe(Effect.scoped),
		);
		expect(initializations).toHaveLength(2);
		expect(initializations[0]).toMatch(/^[0-9a-f-]{36}$/u);
		expect(initializations[1]).toBeUndefined();
	});
});

it("requires current automation administration even when workspace editing is allowed", async () => {
	let admin = false;
	const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
		Response.json({ permission: "edit", automationAdmin: admin }),
	);
	vi.stubGlobal("fetch", fetcher);
	try {
		const request = {
			config: { apiUrl: "https://api.test", workspaceId: "workspace" },
			credential: { credential: "runtime", generation: 1, gatewayEpoch: 1 },
			actorId: "editor",
			membershipId: "member-1",
		};
		await expect(
			Effect.runPromise(authorizeCloudRuntimeAutomations(request)),
		).rejects.toThrow();
		admin = true;
		await Effect.runPromise(authorizeCloudRuntimeAutomations(request));
		admin = false;
		await expect(
			Effect.runPromise(authorizeCloudRuntimeAutomations(request)),
		).rejects.toThrow();
		expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
			purpose: "automation",
			actorId: "editor",
			membershipId: "member-1",
		});
	} finally {
		vi.unstubAllGlobals();
	}
});
