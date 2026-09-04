import type { ClientCommand } from "@zuse/client-runtime/client-persistence";
import {
	CloudCommandTerminalError,
	CloudCommandTransportUnavailableError,
	commandFingerprint,
} from "@zuse/client-runtime/client-persistence";
import {
	CloudCommandEnvelope,
	CloudWorkspaceOpError,
	CommandId,
	EnvironmentId,
	SessionId,
} from "@zuse/contracts";
import {
	cloudCommandAdditionalData,
	encryptCloudCommandBody,
} from "@zuse/utils/cloud-command-crypto";
import { bytesToBase64Url } from "@zuse/utils/cloud-transcript-crypto";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	cancel: vi.fn(),
	dataKey: vi.fn(),
	enqueue: vi.fn(),
	status: vi.fn(),
	watch: vi.fn(),
	workspace: vi.fn(),
}));

vi.mock("../../src/lib/rpc-client.ts", () => ({
	getControlPlaneRpcClient: async () => ({
		"cloud.commands.cancel": mocks.cancel,
		"cloud.commands.dataKey": mocks.dataKey,
		"cloud.commands.enqueue": mocks.enqueue,
		"cloud.commands.status": mocks.status,
		"cloud.commands.watch": mocks.watch,
		"cloud.workspaces.get": mocks.workspace,
	}),
}));

import { cloudCommandTransport } from "../../src/lib/cloud-command-transport.ts";

const environmentId = EnvironmentId.make("workspace_test");
const sessionId = SessionId.make("session_test");
const baseCommandId = CommandId.make("command_test");
const persistedEnvelopeFingerprint = "hmac-sha256:persisted";
const composerInput = {
	text: "hello",
	attachments: [],
	fileRefs: [],
	skillRefs: [],
	annotations: [],
} as const;
const command: ClientCommand = {
	kind: "messages.send",
	commandId: baseCommandId,
	environmentId,
	resource: {
		kind: "session-timeline",
		ref: { environmentId, sessionId },
	},
	payload: {
		commandId: baseCommandId,
		sessionId,
		clientMessageId: "message_test",
		input: composerInput,
	},
	retry: "safe",
	createdAt: 1,
};

const missing = () =>
	Effect.fail(new CloudWorkspaceOpError({ code: "not-found" }));

const lifecycle = (state: "ready" | "archived" | "deleted") =>
	Effect.succeed({ state, desiredState: state === "ready" ? "ready" : state });

const dispatch = () => {
	const handle = cloudCommandTransport.dispatch({
		command,
		fingerprint: commandFingerprint(command),
	});
	void handle.result.catch(() => undefined);
	void handle.encryptedEnvelope?.catch(() => undefined);
	void handle.deliveryFingerprint.catch(() => undefined);
	handle.start();
	return handle;
};

const persistedEnvelope = (): CloudCommandEnvelope =>
	CloudCommandEnvelope.make({
		protocolVersion: 3,
		workspaceId: environmentId,
		sessionId,
		commandId: command.commandId,
		kind: command.kind,
		fingerprint: persistedEnvelopeFingerprint,
		schemaVersion: 1,
		keyVersion: 1,
		destructionFence: 0,
		createdAt: command.createdAt,
		iv: "persisted-iv",
		ciphertext: "persisted-ciphertext",
		dependencies: [],
	});

const resume = (options?: {
	readonly deliveryStatus?: Parameters<
		typeof cloudCommandTransport.resume
	>[0]["deliveryStatus"];
}) => {
	const fingerprint = commandFingerprint(command);
	const envelope = persistedEnvelope();
	const handle = cloudCommandTransport.resume({
		command,
		fingerprint,
		encryptedEnvelope: envelope,
		acceptance: {
			commandId: command.commandId,
			workspaceSequence: 1,
			revision: 2,
			acceptedAt: 3,
			state: "waiting-for-runtime",
		},
		...(options?.deliveryStatus === undefined
			? {}
			: { deliveryStatus: options.deliveryStatus }),
	});
	void handle.result.catch(() => undefined);
	void handle.encryptedEnvelope.catch(() => undefined);
	void handle.deliveryFingerprint.catch(() => undefined);
	handle.start();
	return handle;
};

const deferred = <Value>() => {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((onResolve) => {
		resolve = onResolve;
	});
	return { promise, resolve };
};

const waitUntil = async (predicate: () => boolean): Promise<void> => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not reached");
};

describe("cloud command transport rollout compatibility", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.dataKey.mockReturnValue(missing());
	});

	it("falls back to live RPC when an older control plane lacks mailbox routes", async () => {
		mocks.workspace.mockReturnValue(lifecycle("ready"));

		await expect(dispatch().accepted).rejects.toBeInstanceOf(
			CloudCommandTransportUnavailableError,
		);
		expect(mocks.workspace).toHaveBeenCalledWith({
			workspaceId: environmentId,
		});
	});

	it.each([
		"archived",
		"deleted",
	] as const)("reports a confirmed %s lifecycle as terminal", async (state) => {
		mocks.workspace.mockReturnValue(lifecycle(state));

		await expect(dispatch().accepted).rejects.toMatchObject({
			name: "CloudCommandTerminalError",
			category: "workspace-deleted",
		});
	});

	it("reports a data-key lifecycle conflict as a terminal deleted workspace", async () => {
		mocks.dataKey.mockReturnValue(
			Effect.fail(new CloudWorkspaceOpError({ code: "conflict" })),
		);
		mocks.workspace.mockReturnValue(lifecycle("deleted"));

		await expect(dispatch().accepted).rejects.toMatchObject({
			name: "CloudCommandTerminalError",
			state: "cancelled",
			category: "workspace-deleted",
		});
		expect(mocks.workspace).toHaveBeenCalledWith({
			workspaceId: environmentId,
		});
	});

	it("reports a workspace as terminal only when the existing endpoint also cannot find it", async () => {
		mocks.workspace.mockReturnValue(missing());

		await expect(dispatch().accepted).rejects.toBeInstanceOf(
			CloudCommandTerminalError,
		);
	});

	it("advertises the attachment-free send slice with typed model options", () => {
		expect(cloudCommandTransport.supports(command)).toBe(true);
		expect(
			cloudCommandTransport.supports({
				...command,
				payload: {
					...(command.payload as Readonly<Record<string, unknown>>),
					clientMessageId: undefined,
				},
			}),
		).toBe(false);
		expect(
			cloudCommandTransport.supports({
				...command,
				payload: {
					...(command.payload as Readonly<Record<string, unknown>>),
					input: {
						...composerInput,
						attachments: [
							{
								id: "attachment",
								mimeType: "text/plain",
								originalName: "attachment.txt",
							},
						],
					},
				},
			}),
		).toBe(false);
		expect(
			cloudCommandTransport.supports({
				...command,
				payload: {
					...(command.payload as Readonly<Record<string, unknown>>),
					input: {
						...composerInput,
						modelOptions: { reasoning: "high" },
					},
				},
			}),
		).toBe(false);
		expect(
			cloudCommandTransport.supports({
				...command,
				payload: {
					...(command.payload as Readonly<Record<string, unknown>>),
					asGoal: true,
				},
			}),
		).toBe(false);
		expect(
			cloudCommandTransport.supports({
				...command,
				payload: {
					...(command.payload as Readonly<Record<string, unknown>>),
					input: { ...composerInput, asGoal: true },
				},
			}),
		).toBe(false);
		expect(
			cloudCommandTransport.supports({
				...command,
				payload: {
					...(command.payload as Readonly<Record<string, unknown>>),
					modelOptions: { reasoning: "high" },
				},
			}),
		).toBe(true);
		expect(
			cloudCommandTransport.supports({
				...command,
				payload: {
					...(command.payload as Readonly<Record<string, unknown>>),
					modelOptions: { reasoning: 1 },
				},
			}),
		).toBe(false);
		expect(
			cloudCommandTransport.supports({ ...command, kind: "session.rename" }),
		).toBe(false);
	});

	it("re-enqueues the exact persisted envelope after an ambiguous pre-acceptance failure", async () => {
		const envelope = persistedEnvelope();
		mocks.enqueue.mockImplementation((received: CloudCommandEnvelope) =>
			Effect.succeed({
				commandId: received.commandId,
				workspaceSequence: 7,
				revision: 8,
				acceptedAt: 9,
				state: "accepted",
			}),
		);
		mocks.status.mockReturnValue(
			Effect.succeed({
				commandId: envelope.commandId,
				workspaceSequence: 7,
				revision: 10,
				fingerprint: envelope.fingerprint,
				state: "cancelled",
				everLeased: false,
				updatedAt: 11,
				category: "test-cleanup",
			}),
		);
		const watch = deferred<{
			changes: never[];
			nextRevision: number;
			resetRequired: boolean;
		}>();
		mocks.watch.mockReturnValue(Effect.promise(() => watch.promise));
		const handle = cloudCommandTransport.resume({
			command,
			fingerprint: commandFingerprint(command),
			encryptedEnvelope: envelope,
		});
		void handle.result.catch(() => undefined);
		handle.start();

		await expect(handle.accepted).resolves.toMatchObject({ revision: 8 });
		expect(mocks.enqueue).toHaveBeenCalledTimes(1);
		expect(mocks.enqueue.mock.calls[0]?.[0]).toEqual(envelope);
		await expect(handle.result).rejects.toMatchObject({
			state: "cancelled",
			category: "test-cleanup",
		});
		watch.resolve({ changes: [], nextRevision: 10, resetRequired: false });
	});

	it("rejects a resumed status belonging to another keyed command", async () => {
		mocks.status.mockReturnValue(
			Effect.succeed({
				commandId: command.commandId,
				workspaceSequence: 1,
				revision: 3,
				fingerprint: "hmac-sha256:different-command",
				state: "cancelled",
				everLeased: false,
				updatedAt: 4,
			}),
		);
		const watch = deferred<{
			changes: never[];
			nextRevision: number;
			resetRequired: boolean;
		}>();
		mocks.watch.mockReturnValue(Effect.promise(() => watch.promise));

		const handle = resume();
		await expect(handle.result).rejects.toMatchObject({
			name: "CloudCommandTerminalError",
			state: "rejected",
			category: "command-identity-collision",
		});
		watch.resolve({ changes: [], nextRevision: 3, resetRequired: false });
	});

	it("stops status observation when a resumed attempt is disposed", async () => {
		const envelope = persistedEnvelope();
		mocks.status.mockReturnValue(
			Effect.succeed({
				commandId: command.commandId,
				workspaceSequence: 1,
				revision: 3,
				fingerprint: envelope.fingerprint,
				state: "waiting-for-runtime",
				everLeased: false,
				updatedAt: 4,
			}),
		);
		const watch = deferred<{
			changes: never[];
			nextRevision: number;
			resetRequired: boolean;
		}>();
		mocks.watch.mockReturnValue(Effect.promise(() => watch.promise));

		const handle = resume();
		await handle.accepted;
		await waitUntil(
			() =>
				mocks.status.mock.calls.length === 1 &&
				mocks.watch.mock.calls.length === 1,
		);

		handle.dispose();
		await expect(handle.result).rejects.toThrow(
			"Cloud command attempt disposed",
		);
		watch.resolve({ changes: [], nextRevision: 3, resetRequired: false });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(mocks.status).toHaveBeenCalledTimes(1);
		expect(mocks.watch).toHaveBeenCalledTimes(1);
	});

	it("falls back to live RPC when enqueue discovers a retained runtime without mailbox support", async () => {
		const encodedKey = bytesToBase64Url(new Uint8Array(32).fill(3));
		mocks.dataKey
			.mockReturnValueOnce(
				Effect.succeed({
					workspaceId: environmentId,
					encodedKey,
					keyVersion: 1,
					destructionFence: 0,
					mailboxEnabled: true,
				}),
			)
			.mockReturnValueOnce(
				Effect.succeed({
					workspaceId: environmentId,
					encodedKey,
					keyVersion: 1,
					destructionFence: 0,
					mailboxEnabled: false,
				}),
			);
		mocks.enqueue.mockReturnValue(
			Effect.fail(new CloudWorkspaceOpError({ code: "conflict" })),
		);
		mocks.status.mockReturnValue(missing());

		await expect(dispatch().accepted).rejects.toBeInstanceOf(
			CloudCommandTransportUnavailableError,
		);
		expect(mocks.dataKey).toHaveBeenCalledTimes(2);
	});

	it("reports an unreadable applied result as a terminal outcome", async () => {
		const encodedKey = bytesToBase64Url(new Uint8Array(32).fill(5));
		let keyedFingerprint = "";
		mocks.dataKey.mockReturnValue(
			Effect.succeed({
				workspaceId: environmentId,
				encodedKey,
				keyVersion: 1,
				destructionFence: 0,
				mailboxEnabled: true,
			}),
		);
		mocks.enqueue.mockImplementation((envelope: CloudCommandEnvelope) => {
			keyedFingerprint = envelope.fingerprint;
			return Effect.succeed({
				commandId: command.commandId,
				workspaceSequence: 1,
				revision: 2,
				acceptedAt: 3,
				state: "accepted",
			});
		});
		const applied = {
			commandId: command.commandId,
			workspaceSequence: 1,
			revision: 3,
			state: "applied",
			everLeased: true,
			updatedAt: 4,
			resultIv: "invalid-iv",
			resultCiphertext: "invalid-ciphertext",
		} as const;
		mocks.status.mockImplementation(() =>
			Effect.succeed({ ...applied, fingerprint: keyedFingerprint }),
		);
		mocks.watch.mockImplementation(() =>
			Effect.succeed({
				changes: [{ ...applied, fingerprint: keyedFingerprint }],
				nextRevision: applied.revision,
				resetRequired: false,
			}),
		);

		const handle = dispatch();
		await expect(handle.accepted).resolves.toMatchObject({ revision: 2 });
		await expect(handle.result).rejects.toMatchObject({
			name: "CloudCommandTerminalError",
			state: "outcome-unknown",
			category: "result-invalid",
		});
	});

	it("observes a deleted workspace terminal status before requesting its data key", async () => {
		mocks.dataKey.mockReturnValue(
			Effect.fail(new CloudWorkspaceOpError({ code: "conflict" })),
		);
		const terminal = {
			commandId: command.commandId,
			workspaceSequence: 1,
			revision: 3,
			fingerprint: persistedEnvelopeFingerprint,
			state: "cancelled",
			everLeased: false,
			updatedAt: 4,
			category: "workspace-deleted",
		} as const;
		mocks.status.mockReturnValue(Effect.succeed(terminal));
		const watch = deferred<{
			changes: never[];
			nextRevision: number;
			resetRequired: boolean;
		}>();
		mocks.watch.mockReturnValue(Effect.promise(() => watch.promise));

		const handle = resume();
		await expect(handle.result).rejects.toMatchObject({
			name: "CloudCommandTerminalError",
			state: "cancelled",
			category: "workspace-deleted",
		});
		expect(mocks.status).toHaveBeenCalledTimes(1);
		expect(mocks.dataKey).not.toHaveBeenCalled();
		watch.resolve({ changes: [], nextRevision: 3, resetRequired: false });
	});

	it.each([
		["not-allowed", "auth-restored", "sign-in-required"],
		["beta-access-required", "manual-retry", "beta-access-required"],
		["invalid-request", "runtime-compatible", "update-required"],
	] as const)("publishes a typed blocking status for %s status failures", async (code, blockedUntil, category) => {
		const encodedKey = bytesToBase64Url(new Uint8Array(32).fill(6));
		mocks.dataKey.mockReturnValue(
			Effect.succeed({
				workspaceId: environmentId,
				encodedKey,
				keyVersion: 1,
				destructionFence: 0,
				mailboxEnabled: true,
			}),
		);
		const terminal = {
			commandId: command.commandId,
			workspaceSequence: 1,
			revision: 3,
			fingerprint: persistedEnvelopeFingerprint,
			state: "cancelled",
			everLeased: false,
			updatedAt: 4,
			category: "test-cleanup",
		} as const;
		mocks.status
			.mockReturnValueOnce(Effect.fail(new CloudWorkspaceOpError({ code })))
			.mockReturnValue(Effect.succeed(terminal));
		const watch = deferred<{
			changes: never[];
			nextRevision: number;
			resetRequired: boolean;
		}>();
		mocks.watch.mockReturnValue(Effect.promise(() => watch.promise));
		let resolveBlocked!: (status: unknown) => void;
		const blocked = new Promise<unknown>((resolve) => {
			resolveBlocked = resolve;
		});

		const handle = resume();
		handle.subscribeStatus?.((status) => {
			if (status.state === "blocked") resolveBlocked(status);
		});
		const observed = await Promise.race([
			blocked,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 30)),
		]);
		await expect(handle.result).rejects.toMatchObject({
			state: "cancelled",
			category: "test-cleanup",
		});
		watch.resolve({ changes: [], nextRevision: 3, resetRequired: false });
		expect(observed).toMatchObject({
			state: "blocked",
			blockedUntil,
			category,
		});
	});

	it("publishes a typed blocking status when the workspace watch loses authorization", async () => {
		const encodedKey = bytesToBase64Url(new Uint8Array(32).fill(8));
		mocks.dataKey.mockReturnValue(
			Effect.succeed({
				workspaceId: environmentId,
				encodedKey,
				keyVersion: 1,
				destructionFence: 0,
				mailboxEnabled: true,
			}),
		);
		mocks.status.mockReturnValue(
			Effect.succeed({
				commandId: command.commandId,
				workspaceSequence: 1,
				revision: 2,
				fingerprint: persistedEnvelopeFingerprint,
				state: "waiting-for-runtime",
				everLeased: false,
				updatedAt: 3,
			}),
		);
		const recoveredWatch = deferred<{
			changes: readonly [
				{
					commandId: typeof command.commandId;
					workspaceSequence: number;
					revision: number;
					fingerprint: string;
					state: "cancelled";
					everLeased: false;
					updatedAt: number;
					category: string;
				},
			];
			nextRevision: number;
			resetRequired: boolean;
		}>();
		mocks.watch
			.mockReturnValueOnce(
				Effect.fail(new CloudWorkspaceOpError({ code: "not-allowed" })),
			)
			.mockReturnValue(Effect.promise(() => recoveredWatch.promise));
		let resolveBlocked!: (status: unknown) => void;
		const blocked = new Promise<unknown>((resolve) => {
			resolveBlocked = resolve;
		});

		const handle = resume();
		handle.subscribeStatus?.((status) => {
			if (status.state === "blocked") resolveBlocked(status);
		});
		const observed = await Promise.race([
			blocked,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 30)),
		]);
		expect(observed).toMatchObject({
			state: "blocked",
			blockedUntil: "auth-restored",
			category: "sign-in-required",
		});
		await waitUntil(() => mocks.watch.mock.calls.length === 2);
		recoveredWatch.resolve({
			changes: [
				{
					commandId: command.commandId,
					workspaceSequence: 1,
					revision: 3,
					fingerprint: persistedEnvelopeFingerprint,
					state: "cancelled",
					everLeased: false,
					updatedAt: 4,
					category: "test-cleanup",
				},
			],
			nextRevision: 3,
			resetRequired: false,
		});
		await expect(handle.result).rejects.toMatchObject({ state: "cancelled" });
	});

	it("fans commands into one workspace cursor and resynchronizes every pending command before a reset advance", async () => {
		const encodedKey = bytesToBase64Url(new Uint8Array(32).fill(7));
		const envelopeFingerprints = new Map<string, string>();
		mocks.dataKey.mockReturnValue(
			Effect.succeed({
				workspaceId: environmentId,
				encodedKey,
				keyVersion: 1,
				destructionFence: 0,
				mailboxEnabled: true,
			}),
		);
		mocks.enqueue.mockImplementation((envelope: CloudCommandEnvelope) => {
			envelopeFingerprints.set(envelope.commandId, envelope.fingerprint);
			return Effect.succeed({
				commandId: envelope.commandId,
				workspaceSequence: envelope.commandId.endsWith("one") ? 1 : 2,
				revision: envelope.commandId.endsWith("one") ? 10 : 11,
				acceptedAt: 12,
				state: "accepted",
			});
		});

		const firstCommand = {
			...command,
			commandId: CommandId.make("command_one"),
			payload: {
				...(command.payload as Readonly<Record<string, unknown>>),
				commandId: CommandId.make("command_one"),
			},
		};
		const secondCommand = {
			...command,
			commandId: CommandId.make("command_two"),
			payload: {
				...(command.payload as Readonly<Record<string, unknown>>),
				commandId: CommandId.make("command_two"),
			},
		};
		const first = cloudCommandTransport.dispatch({
			command: firstCommand,
			fingerprint: commandFingerprint(firstCommand),
		});
		const second = cloudCommandTransport.dispatch({
			command: secondCommand,
			fingerprint: commandFingerprint(secondCommand),
		});
		void first.result.catch(() => undefined);
		void second.result.catch(() => undefined);
		const firstEnvelope =
			(await first.encryptedEnvelope) as CloudCommandEnvelope;
		const secondEnvelope =
			(await second.encryptedEnvelope) as CloudCommandEnvelope;
		const encryptedResults = new Map(
			await Promise.all(
				([firstEnvelope, secondEnvelope] as const).map(
					async (envelope) =>
						[
							envelope.commandId,
							await encryptCloudCommandBody({
								encodedKey,
								additionalData: cloudCommandAdditionalData(envelope),
								plaintext: new TextEncoder().encode(
									JSON.stringify({
										commandId: envelope.commandId,
										result: null,
									}),
								),
							}),
						] as const,
				),
			),
		);
		const statusCalls = new Map<string, number>();
		mocks.status.mockImplementation(({ commandId }) => {
			const calls = (statusCalls.get(commandId) ?? 0) + 1;
			statusCalls.set(commandId, calls);
			if (calls === 1)
				return Effect.succeed({
					commandId,
					workspaceSequence: commandId.endsWith("one") ? 1 : 2,
					revision: 12,
					fingerprint: envelopeFingerprints.get(commandId),
					state: "waiting-for-runtime",
					everLeased: false,
					updatedAt: 13,
				});
			return Effect.succeed({
				commandId,
				workspaceSequence: commandId.endsWith("one") ? 1 : 2,
				revision: commandId.endsWith("one") ? 50 : 51,
				fingerprint: envelopeFingerprints.get(commandId),
				state: "applied",
				everLeased: true,
				updatedAt: 52,
				resultIv: encryptedResults.get(commandId)?.iv,
				resultCiphertext: encryptedResults.get(commandId)?.ciphertext,
			});
		});
		const watch = deferred<{
			changes: never[];
			nextRevision: number;
			resetRequired: boolean;
		}>();
		mocks.watch.mockReturnValue(Effect.promise(() => watch.promise));

		first.start();
		second.start();
		await waitUntil(
			() =>
				mocks.watch.mock.calls.length === 1 &&
				statusCalls.get(firstCommand.commandId) === 1 &&
				statusCalls.get(secondCommand.commandId) === 1,
		);
		watch.resolve({ changes: [], nextRevision: 49, resetRequired: true });

		await expect(Promise.all([first.result, second.result])).resolves.toEqual([
			expect.objectContaining({
				commandId: firstCommand.commandId,
				result: null,
			}),
			expect.objectContaining({
				commandId: secondCommand.commandId,
				result: null,
			}),
		]);
		expect(mocks.watch).toHaveBeenCalledTimes(1);
		expect(statusCalls.get(firstCommand.commandId)).toBe(2);
		expect(statusCalls.get(secondCommand.commandId)).toBe(2);
	});

	it("recovers a lost enqueue response only from the same keyed command identity", async () => {
		const encodedKey = bytesToBase64Url(new Uint8Array(32).fill(9));
		let keyedFingerprint = "";
		mocks.dataKey.mockReturnValue(
			Effect.succeed({
				workspaceId: environmentId,
				encodedKey,
				keyVersion: 1,
				destructionFence: 0,
				mailboxEnabled: true,
			}),
		);
		mocks.enqueue.mockImplementation((envelope: CloudCommandEnvelope) => {
			keyedFingerprint = envelope.fingerprint;
			return Effect.fail(new Error("enqueue response lost"));
		});
		mocks.status.mockImplementation(() =>
			Effect.succeed({
				commandId: command.commandId,
				workspaceSequence: 1,
				revision: 3,
				fingerprint: keyedFingerprint,
				state: "applied",
				everLeased: true,
				updatedAt: 4,
			}),
		);

		const handle = dispatch();
		await expect(handle.accepted).resolves.toMatchObject({ revision: 3 });
		await expect(handle.result).rejects.toMatchObject({
			name: "CloudCommandTerminalError",
			category: "result-expired",
		});
	});

	it("rejects a failure-terminal status instead of fabricating mailbox acceptance", async () => {
		const encodedKey = bytesToBase64Url(new Uint8Array(32).fill(12));
		let keyedFingerprint = "";
		mocks.dataKey.mockReturnValue(
			Effect.succeed({
				workspaceId: environmentId,
				encodedKey,
				keyVersion: 1,
				destructionFence: 0,
				mailboxEnabled: true,
			}),
		);
		mocks.enqueue.mockImplementation((envelope: CloudCommandEnvelope) => {
			keyedFingerprint = envelope.fingerprint;
			return Effect.fail(new Error("enqueue response lost"));
		});
		mocks.status.mockImplementation(() =>
			Effect.succeed({
				commandId: command.commandId,
				workspaceSequence: 1,
				revision: 3,
				fingerprint: keyedFingerprint,
				state: "cancelled",
				everLeased: false,
				updatedAt: 4,
				category: "reservation-expired",
			}),
		);

		await expect(dispatch().accepted).rejects.toMatchObject({
			name: "CloudCommandTerminalError",
			state: "cancelled",
			category: "reservation-expired",
		});
	});

	it("rejects an enqueue collision instead of adopting another command's status", async () => {
		const encodedKey = bytesToBase64Url(new Uint8Array(32).fill(10));
		mocks.dataKey.mockReturnValue(
			Effect.succeed({
				workspaceId: environmentId,
				encodedKey,
				keyVersion: 1,
				destructionFence: 0,
				mailboxEnabled: true,
			}),
		);
		mocks.enqueue.mockReturnValue(
			Effect.fail(new CloudWorkspaceOpError({ code: "conflict" })),
		);
		mocks.status.mockReturnValue(
			Effect.succeed({
				commandId: command.commandId,
				workspaceSequence: 1,
				revision: 3,
				fingerprint: "hmac-sha256:different-command",
				state: "accepted",
				everLeased: false,
				updatedAt: 4,
			}),
		);

		await expect(dispatch().accepted).rejects.toMatchObject({
			name: "CloudCommandTerminalError",
			state: "rejected",
			category: "command-identity-collision",
		});
		expect(mocks.dataKey).toHaveBeenCalledTimes(1);
	});

	it("retries a targeted status read when a late subscriber is behind the shared cursor", async () => {
		const encodedKey = bytesToBase64Url(new Uint8Array(32).fill(11));
		const envelopeFingerprints = new Map<string, string>();
		mocks.dataKey.mockReturnValue(
			Effect.succeed({
				workspaceId: environmentId,
				encodedKey,
				keyVersion: 1,
				destructionFence: 0,
				mailboxEnabled: true,
			}),
		);
		mocks.enqueue.mockImplementation((envelope: CloudCommandEnvelope) => {
			envelopeFingerprints.set(envelope.commandId, envelope.fingerprint);
			return Effect.succeed({
				commandId: envelope.commandId,
				workspaceSequence: envelope.commandId.endsWith("old") ? 2 : 1,
				revision: envelope.commandId.endsWith("old") ? 10 : 100,
				acceptedAt: 3,
				state: "accepted",
			});
		});
		const firstCommand = {
			...command,
			commandId: CommandId.make("command_current"),
			payload: {
				...(command.payload as Readonly<Record<string, unknown>>),
				commandId: CommandId.make("command_current"),
			},
		};
		const lateCommand = {
			...command,
			commandId: CommandId.make("command_old"),
			payload: {
				...(command.payload as Readonly<Record<string, unknown>>),
				commandId: CommandId.make("command_old"),
			},
		};
		let lateStatusCalls = 0;
		mocks.status.mockImplementation(({ commandId }) => {
			if (commandId === lateCommand.commandId) {
				lateStatusCalls += 1;
				if (lateStatusCalls === 1)
					return Effect.fail(new Error("temporary status failure"));
				return Effect.succeed({
					commandId,
					workspaceSequence: 2,
					revision: 20,
					fingerprint: envelopeFingerprints.get(commandId),
					state: "applied",
					everLeased: true,
					updatedAt: 21,
				});
			}
			return Effect.succeed({
				commandId,
				workspaceSequence: 1,
				revision: 100,
				fingerprint: envelopeFingerprints.get(commandId),
				state: "waiting-for-runtime",
				everLeased: false,
				updatedAt: 101,
			});
		});
		const watch = deferred<{
			changes: readonly unknown[];
			nextRevision: number;
			resetRequired: boolean;
		}>();
		mocks.watch.mockReturnValue(Effect.promise(() => watch.promise));

		const first = cloudCommandTransport.dispatch({
			command: firstCommand,
			fingerprint: commandFingerprint(firstCommand),
		});
		void first.result.catch(() => undefined);
		first.start();
		await first.accepted;
		await waitUntil(() => mocks.watch.mock.calls.length === 1);

		const late = cloudCommandTransport.dispatch({
			command: lateCommand,
			fingerprint: commandFingerprint(lateCommand),
		});
		void late.result.catch(() => undefined);
		const observedStatuses: Array<{ readonly state: string }> = [];
		late.subscribeStatus?.((status) => observedStatuses.push(status));
		late.start();
		await late.accepted;
		await expect(late.result).rejects.toMatchObject({
			category: "result-expired",
		});
		expect(lateStatusCalls).toBe(2);
		expect(observedStatuses.some((status) => status.state === "blocked")).toBe(
			false,
		);

		watch.resolve({
			changes: [
				{
					commandId: firstCommand.commandId,
					workspaceSequence: 1,
					revision: 101,
					fingerprint: envelopeFingerprints.get(firstCommand.commandId),
					state: "cancelled",
					everLeased: false,
					updatedAt: 102,
				},
			],
			nextRevision: 101,
			resetRequired: false,
		});
		await expect(first.result).rejects.toMatchObject({ state: "cancelled" });
	});
});
