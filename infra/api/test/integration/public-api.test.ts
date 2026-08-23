import { BillingProvidersManual } from "@zuse/billing-providers";
import { MachineProvidersFake } from "@zuse/machine-providers/testing";
import type { SandboxProviderAdapter } from "@zuse/sandbox-providers";
import { makeSandboxProvidersFake } from "@zuse/sandbox-providers/testing";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	AccountIdentity,
	type AccountIdentityApi,
} from "../../src/account-identity.ts";
import {
	deliverPendingApiWebhooks,
	signWebhookPayload,
} from "../../src/api-webhook-dispatch.ts";
import { BetaAccessAllowAll } from "../../src/beta-access.ts";
import { CloudBillingStoreMemory } from "../../src/cloud-billing-store-memory.ts";
import {
	CloudWorkspaceLaunchIntentCipher,
	CloudWorkspaceLaunchIntentCipherLive,
} from "../../src/cloud-workspace-launch-intent.ts";
import {
	CloudWorkspaceStore,
	type CloudWorkspaceStoreApi,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import { layer as configurationLayer } from "../../src/config.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { handleRequest } from "../../src/handler.ts";
import { MachineControlConfiguration } from "../../src/machine-config.ts";
import { MachineStoreMemory } from "../../src/machine-store.ts";
import { ManagedTunnelProviderLive } from "../../src/managed-tunnel.ts";
import { PushDelivery } from "../../src/push.ts";
import { SandboxOfferConfiguration } from "../../src/sandbox-provider-module.ts";
import { ApiStoreMemory } from "../../src/store.ts";
import { WorkosVerifierTest } from "../../src/workos.ts";

const ISSUER = "https://api.test";
const ACCOUNT = "user_a";
const WORKOS_HEADERS = { authorization: `Bearer test-token:${ACCOUNT}` };
const PROVIDER_ID = "fake-cloud";

// The default fake adapter is unadvertised; the public create path selects
// among advertised providers, so register one the way api.test.ts does.
const advertisedAdapter: SandboxProviderAdapter = {
	providerId: PROVIDER_ID,
	displayName: "Test cloud",
	templateVersion: "test-template",
	create: () => Effect.die("unused"),
	fork: () => Effect.die("unused"),
	recoverByLabel: () => Effect.succeed(null),
	startProcess: () => Effect.void,
	replaceProcess: () => Effect.void,
	pathExists: () => Effect.succeed(false),
	readTextFile: () => Effect.succeed(""),
	writeTextFile: () => Effect.void,
	inspect: () => Effect.succeed(null),
	resolveEndpoint: () => Effect.die("unused"),
	pause: () => Effect.void,
	resume: () => Effect.die("unused"),
	extendTimeout: () => Effect.void,
	setNetwork: () => Effect.void,
	snapshot: () => Effect.die("unused"),
	kill: () => Effect.void,
	deleteSnapshot: () => Effect.void,
};

const makeRuntime = async () => {
	const mint = await generateKeyPair("EdDSA", { extractable: true });
	const config = configurationLayer({
		apiIssuer: ISSUER,
		workosJwksUrl: "https://unused.test/jwks",
		workosIssuer: "https://unused.test",
		mintPrivateKey: Redacted.make(
			JSON.stringify(await exportJWK(mint.privateKey)),
		),
		mintPublicKey: JSON.stringify(await exportJWK(mint.publicKey)),
		cloudDataEncryptionKey: Redacted.make(
			"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		),
	});
	const layer = Layer.mergeAll(
		config,
		BetaAccessAllowAll,
		WorkosVerifierTest,
		ApiStoreMemory,
		CloudWorkspaceStoreMemory,
		CloudBillingStoreMemory,
		MachineStoreMemory,
		MachineProvidersFake,
		BillingProvidersManual,
		makeSandboxProvidersFake([
			{ adapter: advertisedAdapter, advertised: true },
		]),
		Layer.effect(
			CloudWorkspaceLaunchIntentCipher,
			CloudWorkspaceLaunchIntentCipherLive,
		).pipe(Layer.provide(config), Layer.orDie),
		Layer.succeed(SandboxOfferConfiguration, {
			port: 47_837,
			vcpuCount: 2,
			memoryMib: 1_024,
			createTimeoutSeconds: 86_400,
			keepAliveTimeoutSeconds: 86_400,
		}),
		Layer.succeed(MachineControlConfiguration, {
			allowlistedAccountIds: new Set([ACCOUNT]),
			manualEntitlementsEnabled: true,
			liveCheckoutEnabled: false,
			enrollmentTtlMs: 30 * 60 * 1_000,
			recoveryWindowMs: 7 * 24 * 60 * 60 * 1_000,
			finalSnapshotRetentionMs: 14 * 24 * 60 * 60 * 1_000,
			reconcileLeaseMs: 5 * 60 * 1_000,
		}),
		ManagedTunnelProviderLive.pipe(Layer.provide(config)),
		Layer.succeed(PushDelivery, PushDelivery.of({ send: () => Effect.void })),
		Layer.succeed(
			AccountIdentity,
			AccountIdentity.of({
				deleteUser: () => Effect.void,
				verifiedEmail: () => Effect.succeed(null),
			} satisfies AccountIdentityApi),
		),
	);
	return ManagedRuntime.make(layer);
};

type Runtime = Awaited<ReturnType<typeof makeRuntime>>;

const serve = (
	runtime: Runtime,
	path: string,
	init?: RequestInit,
): Promise<Response> =>
	runtime.runPromise(handleRequest(new Request(`${ISSUER}${path}`, init)));

const json = async <T>(response: Response, status: number): Promise<T> => {
	if (response.status !== status) {
		const body = await response.clone().text();
		expect(`${response.status}: ${body}`).toBe(`${status}`);
	}
	expect(response.status).toBe(status);
	return (await response.json()) as T;
};

const seedReadyProject = async (
	runtime: Runtime,
	store: CloudWorkspaceStoreApi,
): Promise<void> => {
	const now = Date.now();
	await runtime.runPromise(
		store.connectProject({
			projectId: "project-1",
			accountId: ACCOUNT,
			repositoryIdentity: "github.com/acme/app",
			repositoryUrl: "https://github.com/acme/app.git",
			displayName: "acme/app",
			defaultBranch: "main",
			visibility: "private",
			gitConnectionKind: "github-app",
			cloudEnvironment: {},
			secretBindings: [],
			configurationDigest: "digest-1",
			state: "ready",
			idempotencyKey: "project-1",
			createdAtMs: now,
			updatedAtMs: now,
		}),
	);
	await runtime.runPromise(
		store.createBuild({
			buildId: "build-1",
			projectId: "project-1",
			accountId: ACCOUNT,
			provider: PROVIDER_ID,
			snapshotId: "snapshot-1",
			templateVersion: "test-template",
			configurationDigest: "digest-1",
			state: "ready",
			idempotencyKey: "build-1",
			nextActionAtMs: now,
			revision: 0,
			createdAtMs: now,
			updatedAtMs: now,
		}),
	);
};

const createApiKey = async (runtime: Runtime): Promise<string> => {
	const created = await json<{ key: { keyId: string }; secret: string }>(
		await serve(runtime, "/v1/cloud/api-keys", {
			method: "POST",
			headers: { ...WORKOS_HEADERS, "content-type": "application/json" },
			body: JSON.stringify({ name: "ci bot" }),
		}),
		201,
	);
	expect(created.secret.startsWith("zk_")).toBe(true);
	return created.secret;
};

const stageRuntimeCredential = async (
	runtime: Runtime,
	store: CloudWorkspaceStoreApi,
	workspaceId: string,
	secret: string,
): Promise<void> => {
	const workspace = await runtime.runPromise(store.getWorkspace(workspaceId));
	if (workspace === null) throw new Error("workspace missing");
	await runtime.runPromise(
		store.saveWorkspace({
			...workspace,
			runtimeCredentialHash: await runtime.runPromise(sha256Hex(secret)),
			requestConfig: {
				...workspace.requestConfig,
				runtimeCredentialExpiresAtMs: Date.now() + 10 * 60_000,
			},
			revision: workspace.revision + 1,
			updatedAtMs: workspace.updatedAtMs + 1,
		}),
	);
};

describe("public API (/v1/api)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("mints, authenticates, and revokes account API keys", async () => {
		const runtime = await makeRuntime();
		const secret = await createApiKey(runtime);
		const apiHeaders = { authorization: `Bearer ${secret}` };

		const projects = await json<{ projects: ReadonlyArray<unknown> }>(
			await serve(runtime, "/v1/api/projects", { headers: apiHeaders }),
			200,
		);
		expect(projects.projects).toEqual([]);

		const listed = await json<{
			keys: ReadonlyArray<{ keyId: string; prefix: string }>;
		}>(
			await serve(runtime, "/v1/cloud/api-keys", { headers: WORKOS_HEADERS }),
			200,
		);
		expect(listed.keys).toHaveLength(1);
		expect(listed.keys[0]?.prefix).toBe(secret.slice(0, 12));

		const keyId = listed.keys[0]?.keyId ?? "";
		await json(
			await serve(runtime, `/v1/cloud/api-keys/${keyId}`, {
				method: "DELETE",
				headers: WORKOS_HEADERS,
			}),
			200,
		);
		const denied = await serve(runtime, "/v1/api/projects", {
			headers: apiHeaders,
		});
		expect(denied.status).toBe(401);
		const missingKey = await serve(runtime, "/v1/api/projects");
		expect(missingKey.status).toBe(401);
	});

	test("runs the full create → message → drain → turn-event → poll loop", async () => {
		const runtime = await makeRuntime();
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await seedReadyProject(runtime, store);
		const secret = await createApiKey(runtime);
		const apiHeaders = {
			authorization: `Bearer ${secret}`,
			"content-type": "application/json",
		};

		const created = await json<{
			workspace: {
				workspaceId: string;
				state: string;
				agentStatus: string;
				latestSeq: number;
			};
		}>(
			await serve(runtime, "/v1/api/workspaces", {
				method: "POST",
				headers: { ...apiHeaders, "idempotency-key": "task-1" },
				body: JSON.stringify({
					prompt: "Fix the login bug",
					agent: "codex",
					model: "gpt-5",
				}),
			}),
			201,
		);
		const workspaceId = created.workspace.workspaceId;
		expect(created.workspace.state).toBe("queued");
		expect(created.workspace.agentStatus).toBe("working");
		expect(created.workspace.latestSeq).toBe(1);

		// Same Idempotency-Key → the existing workspace, not a duplicate.
		const replayed = await json<{ workspace: { workspaceId: string } }>(
			await serve(runtime, "/v1/api/workspaces", {
				method: "POST",
				headers: { ...apiHeaders, "idempotency-key": "task-1" },
				body: JSON.stringify({
					prompt: "Fix the login bug",
					agent: "codex",
					model: "gpt-5",
				}),
			}),
			200,
		);
		expect(replayed.workspace.workspaceId).toBe(workspaceId);

		const receipt = await json<{
			messageId: string;
			seq: number;
			status: string;
		}>(
			await serve(runtime, `/v1/api/workspaces/${workspaceId}/messages`, {
				method: "POST",
				headers: { ...apiHeaders, "idempotency-key": "m1" },
				body: JSON.stringify({ text: "Also update the docs" }),
			}),
			200,
		);
		expect(receipt.status).toBe("queued");
		expect(receipt.seq).toBe(2);
		const receiptReplay = await json<{ messageId: string; seq: number }>(
			await serve(runtime, `/v1/api/workspaces/${workspaceId}/messages`, {
				method: "POST",
				headers: { ...apiHeaders, "idempotency-key": "m1" },
				body: JSON.stringify({ text: "Also update the docs" }),
			}),
			200,
		);
		expect(receiptReplay.messageId).toBe(receipt.messageId);
		expect(receiptReplay.seq).toBe(receipt.seq);

		// Simulate the in-sandbox runtime draining and acking the command.
		await stageRuntimeCredential(runtime, store, workspaceId, "runtime-secret");
		const runtimeHeaders = {
			authorization: "Bearer runtime-secret",
			"content-type": "application/json",
		};
		const commands = await json<{
			commands: ReadonlyArray<{
				messageId: string;
				commandId: string;
				sessionId: string;
				text: string;
			}>;
		}>(
			await serve(
				runtime,
				`/v1/cloud/workspaces/${workspaceId}/runtime/commands`,
				{
					headers: runtimeHeaders,
				},
			),
			200,
		);
		expect(commands.commands).toHaveLength(1);
		expect(commands.commands[0]?.text).toBe("Also update the docs");
		expect(commands.commands[0]?.commandId).toBe(`api:${receipt.messageId}`);
		await json(
			await serve(
				runtime,
				`/v1/cloud/workspaces/${workspaceId}/runtime/commands/ack`,
				{
					method: "POST",
					headers: runtimeHeaders,
					body: JSON.stringify({ messageId: receipt.messageId }),
				},
			),
			200,
		);

		const webhook = await json<{
			webhook: { webhookId: string };
			secret: string;
		}>(
			await serve(runtime, "/v1/api/webhooks", {
				method: "POST",
				headers: apiHeaders,
				body: JSON.stringify({
					url: "https://hooks.test/zuse",
					description: "test sink",
				}),
			}),
			201,
		);
		expect(webhook.secret.startsWith("whsec_")).toBe(true);

		const workspaceRecord = await runtime.runPromise(
			store.getWorkspace(workspaceId),
		);
		const turnEvent = {
			sessionId: workspaceRecord?.initialSessionId ?? "",
			turnId: "turn-1",
			outcome: "completed",
			settledAt: Date.now(),
			replyText: "Done! The login bug is fixed.",
			replyTruncated: false,
		};
		const recorded = await json<{ recorded: boolean }>(
			await serve(
				runtime,
				`/v1/cloud/workspaces/${workspaceId}/runtime/turn-events`,
				{
					method: "POST",
					headers: runtimeHeaders,
					body: JSON.stringify(turnEvent),
				},
			),
			200,
		);
		expect(recorded.recorded).toBe(true);
		const replayedTurn = await json<{ recorded: boolean }>(
			await serve(
				runtime,
				`/v1/cloud/workspaces/${workspaceId}/runtime/turn-events`,
				{
					method: "POST",
					headers: runtimeHeaders,
					body: JSON.stringify(turnEvent),
				},
			),
			200,
		);
		expect(replayedTurn.recorded).toBe(false);

		const page = await json<{
			messages: ReadonlyArray<{
				seq: number;
				role: string;
				text: string;
				status: string;
				turnId?: string;
			}>;
			latestSeq: number;
		}>(
			await serve(
				runtime,
				`/v1/api/workspaces/${workspaceId}/messages?afterSeq=0`,
				{ headers: apiHeaders },
			),
			200,
		);
		expect(page.latestSeq).toBe(3);
		expect(page.messages.map((message) => message.role)).toEqual([
			"user",
			"user",
			"assistant",
		]);
		expect(page.messages[0]?.text).toBe("Fix the login bug");
		expect(page.messages[1]?.status).toBe("settled");
		expect(page.messages[2]?.text).toBe("Done! The login bug is fixed.");
		expect(page.messages[2]?.turnId).toBe("turn-1");

		const status = await json<{
			workspace: { agentStatus: string; lastTurn: { turnId: string } | null };
		}>(
			await serve(runtime, `/v1/api/workspaces/${workspaceId}`, {
				headers: apiHeaders,
			}),
			200,
		);
		expect(status.workspace.agentStatus).toBe("idle");
		expect(status.workspace.lastTurn?.turnId).toBe("turn-1");

		// Deliver the enqueued webhook with a captured fetch and verify signing.
		const deliveries: Array<{ url: string; body: string; headers: Headers }> =
			[];
		vi.stubGlobal(
			"fetch",
			async (url: string | URL | Request, init?: RequestInit) => {
				deliveries.push({
					url: String(url),
					body: String(init?.body ?? ""),
					headers: new Headers(init?.headers),
				});
				return new Response("ok", { status: 200 });
			},
		);
		const delivered = await runtime.runPromise(deliverPendingApiWebhooks);
		expect(delivered).toBe(1);
		expect(deliveries).toHaveLength(1);
		const delivery = deliveries[0];
		if (delivery === undefined) throw new Error("missing delivery");
		expect(delivery.url).toBe("https://hooks.test/zuse");
		const payload = JSON.parse(delivery.body) as {
			type: string;
			workspaceId: string;
			reply: { text: string };
		};
		expect(payload.type).toBe("workspace.turn.completed");
		expect(payload.workspaceId).toBe(workspaceId);
		expect(payload.reply.text).toBe("Done! The login bug is fixed.");
		const signature = delivery.headers.get("zuse-signature") ?? "";
		const match = /^t=(\d+),v1=([0-9a-f]+)$/u.exec(signature);
		expect(match).not.toBeNull();
		const expected = await signWebhookPayload(
			webhook.secret,
			Number(match?.[1]),
			delivery.body,
		);
		expect(match?.[2]).toBe(expected);
		// Delivered rows are not claimed again.
		expect(await runtime.runPromise(deliverPendingApiWebhooks)).toBe(0);
	});

	test("queues a resume when a message reaches a paused workspace", async () => {
		const runtime = await makeRuntime();
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await seedReadyProject(runtime, store);
		const secret = await createApiKey(runtime);
		const apiHeaders = {
			authorization: `Bearer ${secret}`,
			"content-type": "application/json",
		};
		const created = await json<{ workspace: { workspaceId: string } }>(
			await serve(runtime, "/v1/api/workspaces", {
				method: "POST",
				headers: { ...apiHeaders, "idempotency-key": "task-2" },
				body: JSON.stringify({
					prompt: "Refactor auth",
					agent: "codex",
					model: "gpt-5",
				}),
			}),
			201,
		);
		const workspaceId = created.workspace.workspaceId;
		const workspace = await runtime.runPromise(store.getWorkspace(workspaceId));
		if (workspace === null) throw new Error("workspace missing");
		await runtime.runPromise(
			store.saveWorkspace({
				...workspace,
				state: "paused",
				desiredState: "paused",
				statusCode: "paused",
				revision: workspace.revision + 1,
				updatedAtMs: workspace.updatedAtMs + 1,
			}),
		);

		const receipt = await json<{ resumeTriggered: boolean }>(
			await serve(runtime, `/v1/api/workspaces/${workspaceId}/messages`, {
				method: "POST",
				headers: { ...apiHeaders, "idempotency-key": "wake-1" },
				body: JSON.stringify({ text: "Are you done yet?" }),
			}),
			200,
		);
		expect(receipt.resumeTriggered).toBe(true);
		const resumed = await runtime.runPromise(store.getWorkspace(workspaceId));
		expect(resumed?.desiredState).toBe("ready");
		expect(resumed?.statusCode).toBe("resume-queued");
	});

	test("rejects messages for archived workspaces and foreign keys", async () => {
		const runtime = await makeRuntime();
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await seedReadyProject(runtime, store);
		const secret = await createApiKey(runtime);
		const apiHeaders = {
			authorization: `Bearer ${secret}`,
			"content-type": "application/json",
		};
		const created = await json<{ workspace: { workspaceId: string } }>(
			await serve(runtime, "/v1/api/workspaces", {
				method: "POST",
				headers: { ...apiHeaders, "idempotency-key": "task-3" },
				body: JSON.stringify({
					prompt: "Ship it",
					agent: "codex",
					model: "gpt-5",
				}),
			}),
			201,
		);
		const workspaceId = created.workspace.workspaceId;
		const workspace = await runtime.runPromise(store.getWorkspace(workspaceId));
		if (workspace === null) throw new Error("workspace missing");
		await runtime.runPromise(
			store.saveWorkspace({
				...workspace,
				state: "archived",
				desiredState: "archived",
				statusCode: "archived",
				revision: workspace.revision + 1,
				updatedAtMs: workspace.updatedAtMs + 1,
			}),
		);
		const conflict = await serve(
			runtime,
			`/v1/api/workspaces/${workspaceId}/messages`,
			{
				method: "POST",
				headers: apiHeaders,
				body: JSON.stringify({ text: "hello?" }),
			},
		);
		expect(conflict.status).toBe(409);

		// Another account's key cannot see the workspace at all.
		const foreignKey = await json<{ secret: string }>(
			await serve(runtime, "/v1/cloud/api-keys", {
				method: "POST",
				headers: {
					authorization: "Bearer test-token:user_b",
					"content-type": "application/json",
				},
				body: JSON.stringify({ name: "other" }),
			}),
			201,
		);
		const foreign = await serve(runtime, `/v1/api/workspaces/${workspaceId}`, {
			headers: { authorization: `Bearer ${foreignKey.secret}` },
		});
		expect(foreign.status).toBe(404);
	});
});
