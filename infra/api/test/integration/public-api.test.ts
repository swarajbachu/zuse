import { BillingProvidersManual } from "@zuse/billing-providers";
import {
	CLOUD_COMMAND_PROTOCOL_VERSION,
	CLOUD_RUNTIME_API_ASSETS_CAPABILITY,
} from "@zuse/contracts";
import { MachineProvidersFake } from "@zuse/machine-providers/testing";
import type { SandboxProviderAdapter } from "@zuse/sandbox-providers";
import { makeSandboxProvidersFake } from "@zuse/sandbox-providers/testing";
import { base64UrlToBytes } from "@zuse/utils/cloud-transcript-crypto";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, test, vi } from "vitest";
import slackWorker, {
	type Env as SlackEnv,
} from "../../../../examples/slack-bot/src/worker.ts";
import {
	AccountIdentity,
	type AccountIdentityApi,
} from "../../src/account-identity.ts";
import { apiMessageSealContext, sealApiString } from "../../src/api-sealing.ts";
import {
	deliverPendingApiWebhooks,
	signWebhookPayload,
} from "../../src/api-webhook-dispatch.ts";
import {
	BetaAccess,
	BetaAccessAllowAll,
	BetaAccessDenied,
} from "../../src/beta-access.ts";
import { CloudBillingStoreMemory } from "../../src/cloud-billing-store-memory.ts";
import { takeCloudMailboxDirective } from "../../src/cloud-mailbox-directive.ts";
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
import { MachineStore, MachineStoreMemory } from "../../src/machine-store.ts";
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

const makeRuntime = async (
	betaAccess: Layer.Layer<BetaAccess> = BetaAccessAllowAll,
	cloudBillingEnforcementEnabled = false,
	cloudBrokerEnrollmentEnabled = false,
) => {
	const mint = await generateKeyPair("EdDSA", { extractable: true });
	const objects = new Map<string, string>();
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
		cloudBillingEnforcementEnabled,
		cloudCodexAuthBrokerEnrollmentEnabled: cloudBrokerEnrollmentEnabled,
		cloudProviderAuthBrokerEnrollmentEnabled: cloudBrokerEnrollmentEnabled,
		cloudCommandMailboxEnabled: cloudBrokerEnrollmentEnabled,
		cloudTranscriptObjects: {
			put: (key, value) => {
				if (objects.has(key)) return Promise.resolve("exists" as const);
				objects.set(key, value);
				return Promise.resolve("created" as const);
			},
			get: (key) => Promise.resolve(objects.get(key) ?? null),
			deletePrefix: async (prefix) => {
				for (const key of objects.keys())
					if (key.startsWith(prefix)) objects.delete(key);
			},
		},
	});
	const layer = Layer.mergeAll(
		config,
		betaAccess,
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
	expect(created.secret).toMatch(/^zk_[0-9A-Za-z]{43}$/u);
	return created.secret;
};

const stageRuntimeCredential = async (
	runtime: Runtime,
	store: CloudWorkspaceStoreApi,
	workspaceId: string,
	secret: string,
	capabilities?: ReadonlyArray<string>,
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
				...(capabilities === undefined
					? {}
					: {
							runtimeBootstrapReceipt: {
								workspaceId,
								bootTokenHash: "test-boot-token-hash",
								credentialKeyThumbprint: "test-credential-thumbprint",
								signingKeyThumbprint: "test-signing-thumbprint",
								signingPublicJwk: "{}",
								runtimeCredentialHash: await runtime.runPromise(
									sha256Hex(secret),
								),
								runtimeCredentialExpiresAtMs: Date.now() + 10 * 60_000,
								generation: 1,
								gatewayEpoch: 1,
								sealedTranscriptKey: "test-sealed-transcript-key",
								capabilities,
								enrolledAtMs: Date.now(),
							},
						}),
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
		expect(
			(
				await serve(runtime, "/v1/cloud/api-keys/%E0%A4%A", {
					method: "DELETE",
					headers: WORKOS_HEADERS,
				})
			).status,
		).toBe(400);

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

	test("fails closed after beta removal while key revocation stays available", async () => {
		let betaAllowed = true;
		const runtime = await makeRuntime(
			Layer.succeed(
				BetaAccess,
				BetaAccess.of({
					check: () =>
						betaAllowed ? Effect.void : Effect.fail(new BetaAccessDenied()),
					grant: () => Effect.void,
				}),
			),
		);
		const secret = await createApiKey(runtime);
		const listed = await json<{ keys: ReadonlyArray<{ keyId: string }> }>(
			await serve(runtime, "/v1/cloud/api-keys", { headers: WORKOS_HEADERS }),
			200,
		);
		betaAllowed = false;

		const denied = await serve(runtime, "/v1/api/projects", {
			headers: { authorization: `Bearer ${secret}` },
		});
		expect(denied.status).toBe(403);

		const keyId = listed.keys[0]?.keyId ?? "";
		expect(
			(
				await serve(runtime, `/v1/cloud/api-keys/${keyId}`, {
					method: "DELETE",
					headers: WORKOS_HEADERS,
				})
			).status,
		).toBe(200);
	});

	test("rejects ambiguous idempotency and unsafe webhook targets", async () => {
		const runtime = await makeRuntime();
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await seedReadyProject(runtime, store);
		const secret = await createApiKey(runtime);
		const apiHeaders = {
			authorization: `Bearer ${secret}`,
			"content-type": "application/json",
		};
		const createBody = {
			prompt: "Check idempotency",
			agent: "codex",
			model: "gpt-5",
		};
		const created = await json<{ workspace: { workspaceId: string } }>(
			await serve(runtime, "/v1/api/workspaces", {
				method: "POST",
				headers: { ...apiHeaders, "idempotency-key": "same-create" },
				body: JSON.stringify(createBody),
			}),
			201,
		);
		const project = await runtime.runPromise(store.getProject("project-1"));
		if (project === null) throw new Error("project missing");
		await runtime.runPromise(
			store.saveProject({
				...project,
				state: "failed",
				updatedAtMs: project.updatedAtMs + 1,
			}),
		);
		// Receipt replay is read-only and must not be blocked by project state
		// changing after the original workspace was created.
		expect(
			(
				await serve(runtime, "/v1/api/workspaces", {
					method: "POST",
					headers: { ...apiHeaders, "idempotency-key": "same-create" },
					body: JSON.stringify(createBody),
				})
			).status,
		).toBe(200);
		const storedWorkspace = await runtime.runPromise(
			store.getWorkspace(created.workspace.workspaceId),
		);
		if (storedWorkspace === null) throw new Error("workspace missing");
		const {
			publicApiRequestDigest: _legacyHadNoDigest,
			...legacyRequestConfig
		} = storedWorkspace.requestConfig;
		await runtime.runPromise(
			store.saveWorkspace({
				...storedWorkspace,
				requestConfig: legacyRequestConfig,
				revision: storedWorkspace.revision + 1,
				updatedAtMs: storedWorkspace.updatedAtMs + 1,
			}),
		);
		// Workspaces written by the original public-API migration have no request
		// digest. Their immutable launch prompt and any explicitly supplied config
		// are the compatibility receipt.
		expect(
			(
				await serve(runtime, "/v1/api/workspaces", {
					method: "POST",
					headers: { ...apiHeaders, "idempotency-key": "same-create" },
					body: JSON.stringify(createBody),
				})
			).status,
		).toBe(200);
		expect(
			(
				await serve(runtime, "/v1/api/workspaces", {
					method: "POST",
					headers: { ...apiHeaders, "idempotency-key": "same-create" },
					body: JSON.stringify({ ...createBody, model: "different-model" }),
				})
			).status,
		).toBe(409);
		expect(
			(
				await serve(runtime, "/v1/api/workspaces", {
					method: "POST",
					headers: { ...apiHeaders, "idempotency-key": "same-create" },
					body: JSON.stringify({ ...createBody, prompt: "Different work" }),
				})
			).status,
		).toBe(409);
		expect(
			(
				await serve(runtime, "/v1/api/workspaces", {
					method: "POST",
					headers: { ...apiHeaders, "idempotency-key": "header-key" },
					body: JSON.stringify({ ...createBody, idempotencyKey: "body-key" }),
				})
			).status,
		).toBe(400);

		const messagePath = `/v1/api/workspaces/${created.workspace.workspaceId}/messages`;
		expect(
			(
				await serve(runtime, messagePath, {
					method: "POST",
					headers: apiHeaders,
					body: JSON.stringify({ text: "First", idempotencyKey: "" }),
				})
			).status,
		).toBe(400);
		expect(
			(
				await serve(runtime, messagePath, {
					method: "POST",
					headers: { ...apiHeaders, "idempotency-key": "same-message" },
					body: JSON.stringify({ text: "First" }),
				})
			).status,
		).toBe(200);
		expect(
			(
				await serve(runtime, messagePath, {
					method: "POST",
					headers: { ...apiHeaders, "idempotency-key": "same-message" },
					body: JSON.stringify({ text: "Second" }),
				})
			).status,
		).toBe(409);

		for (const url of [
			"http://hooks.example.test/zuse",
			"https://localhost/zuse",
			"https://worker.localhost./zuse",
			"https://127.0.0.1/zuse",
			`${ISSUER}/v1/api/projects`,
			"https://api.test./v1/api/projects",
			"https://api.test:8443/v1/api/projects",
			"https://user:secret@hooks.example.test/zuse",
			"https://hooks.example.test/zuse#secret",
		]) {
			const response = await serve(runtime, "/v1/api/webhooks", {
				method: "POST",
				headers: apiHeaders,
				body: JSON.stringify({ url }),
			});
			expect(response.status, url).toBe(400);
		}
		expect(
			(
				await serve(runtime, "/v1/api/workspaces/%E0%A4%A", {
					headers: apiHeaders,
				})
			).status,
		).toBe(400);
	});

	test("preserves account auth brokers and first-party mailbox enrollment during shared creation", async () => {
		const runtime = await makeRuntime(BetaAccessAllowAll, false, true);
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await seedReadyProject(runtime, store);
		const secret = await createApiKey(runtime);
		const headers = {
			authorization: `Bearer ${secret}`,
			"content-type": "application/json",
			"idempotency-key": "broker-create",
		};
		const body = JSON.stringify({ agent: "codex", model: "gpt-5" });
		expect(
			await json(
				await serve(runtime, "/v1/api/workspaces", {
					method: "POST",
					headers,
					body,
				}),
				409,
			),
		).toEqual({ error: "codex-auth-update-required" });
		const build = await runtime.runPromise(
			store.getActiveAccountBuild(ACCOUNT, PROVIDER_ID),
		);
		if (build === null) throw new Error("build missing");
		await runtime.runPromise(
			store.saveBuild({
				...build,
				settings: {
					codexAuthDeliveryVersion: 1,
					providerAuthDeliveryVersion: 1,
					providers: [{ providerId: "codex", method: "subscription" }],
				},
			}),
		);
		const created = await json<{ workspace: { workspaceId: string } }>(
			await serve(runtime, "/v1/api/workspaces", {
				method: "POST",
				headers,
				body,
			}),
			201,
		);
		const workspace = await runtime.runPromise(
			store.getWorkspace(created.workspace.workspaceId),
		);
		expect(workspace?.requestConfig).toMatchObject({
			codexAuthMode: "broker-v1",
			providerAuthMode: "broker-v1",
			initialTurnId: expect.any(String),
		});
		const firstParty = await json<{
			workspace: { workspaceId: string };
			initialMessageDelivery: string;
		}>(
			await serve(runtime, "/v1/cloud/workspaces", {
				method: "POST",
				headers: { ...WORKOS_HEADERS, "content-type": "application/json" },
				body: JSON.stringify({
					projectId: "project-1",
					providerId: PROVIDER_ID,
					agent: "codex",
					model: "gpt-5",
					baseRef: "main",
					idempotencyKey: "browser-create",
					initialMessageDelivery: "mailbox-v1",
					firstMessage: "From browser",
				}),
			}),
			201,
		);
		expect(firstParty.initialMessageDelivery).toBe("mailbox-v1");
		const firstPartyRecord = await runtime.runPromise(
			store.getWorkspace(firstParty.workspace.workspaceId),
		);
		expect(firstPartyRecord?.requestConfig).toMatchObject({
			codexAuthMode: "broker-v1",
			providerAuthMode: "broker-v1",
			cloudCommandEnrollmentProtocolVersion: CLOUD_COMMAND_PROTOCOL_VERSION,
		});
		await runtime.dispose();
	});

	test("atomically caps concurrent webhook registrations", async () => {
		const runtime = await makeRuntime();
		const secret = await createApiKey(runtime);
		const apiHeaders = {
			authorization: `Bearer ${secret}`,
			"content-type": "application/json",
		};
		const responses = await Promise.all(
			Array.from({ length: 25 }, (_, index) =>
				serve(runtime, "/v1/api/webhooks", {
					method: "POST",
					headers: apiHeaders,
					body: JSON.stringify({
						url: `https://hooks-${index}.example.test/zuse`,
					}),
				}),
			),
		);
		const statuses = responses.map((response) => response.status);
		expect(statuses.filter((status) => status === 201)).toHaveLength(20);
		expect(statuses.filter((status) => status === 409)).toHaveLength(5);

		const listed = await json<{
			webhooks: ReadonlyArray<{ webhookId: string }>;
		}>(await serve(runtime, "/v1/api/webhooks", { headers: apiHeaders }), 200);
		expect(listed.webhooks).toHaveLength(20);
		const removedWebhookId = listed.webhooks[0]?.webhookId;
		if (removedWebhookId === undefined) throw new Error("missing webhook");
		expect(
			(
				await serve(runtime, `/v1/api/webhooks/${removedWebhookId}`, {
					method: "DELETE",
					headers: apiHeaders,
				})
			).status,
		).toBe(200);
		expect(
			(
				await serve(runtime, "/v1/api/webhooks", {
					method: "POST",
					headers: apiHeaders,
					body: JSON.stringify({
						url: "https://replacement.example.test/zuse",
					}),
				})
			).status,
		).toBe(201);
		await runtime.dispose();
	});

	test("creates an idle workspace and delivers sealed image attachments", async () => {
		const runtime = await makeRuntime();
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await seedReadyProject(runtime, store);
		const secret = await createApiKey(runtime);
		const apiHeaders = { authorization: `Bearer ${secret}` };
		const created = await json<{ workspace: { workspaceId: string } }>(
			await serve(runtime, "/v1/api/workspaces", {
				method: "POST",
				headers: {
					...apiHeaders,
					"content-type": "application/json",
					"idempotency-key": "slack-thread-workspace",
				},
				body: JSON.stringify({ agent: "codex", model: "gpt-5" }),
			}),
			201,
		);
		const workspaceId = created.workspace.workspaceId;
		expect(
			await runtime.runPromise(store.listApiMessages(workspaceId, 0, 20)),
		).toEqual([]);

		const image = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
		const uploaded = await json<{
			asset: {
				assetId: string;
				mimeType: string;
				originalName: string;
				sizeBytes: number;
			};
		}>(
			await serve(runtime, `/v1/api/workspaces/${workspaceId}/attachments`, {
				method: "POST",
				headers: {
					...apiHeaders,
					"content-type": "image/png",
					"x-zuse-file-name": "screenshot.png",
					"idempotency-key": "slack-file-F1",
				},
				body: image,
			}),
			201,
		);
		expect(uploaded.asset).toMatchObject({
			mimeType: "image/png",
			originalName: "screenshot.png",
			sizeBytes: image.byteLength,
		});
		const replayedUpload = await json<{ asset: { assetId: string } }>(
			await serve(runtime, `/v1/api/workspaces/${workspaceId}/attachments`, {
				method: "POST",
				headers: {
					...apiHeaders,
					"content-type": "image/png",
					"x-zuse-file-name": "screenshot.png",
					"idempotency-key": "slack-file-F1",
				},
				body: image,
			}),
			201,
		);
		expect(replayedUpload.asset.assetId).toBe(uploaded.asset.assetId);
		expect(
			(
				await serve(runtime, `/v1/api/workspaces/${workspaceId}/attachments`, {
					method: "POST",
					headers: {
						...apiHeaders,
						"content-type": "image/png",
						"x-zuse-file-name": "screenshot.png",
						"idempotency-key": "slack-file-F1",
					},
					body: new Uint8Array([9, 9, 9]),
				})
			).status,
		).toBe(409);

		await json(
			await serve(runtime, `/v1/api/workspaces/${workspaceId}/messages`, {
				method: "POST",
				headers: {
					...apiHeaders,
					"content-type": "application/json",
					"idempotency-key": "slack-thread-context",
				},
				body: JSON.stringify({
					text: "Inspect this screenshot",
					attachments: [uploaded.asset.assetId],
				}),
			}),
			200,
		);
		await stageRuntimeCredential(runtime, store, workspaceId, "asset-runtime");
		const oldRuntimeCommands = await json<{ commands: ReadonlyArray<unknown> }>(
			await serve(
				runtime,
				`/v1/cloud/workspaces/${workspaceId}/runtime/commands`,
				{ headers: { authorization: "Bearer asset-runtime" } },
			),
			200,
		);
		expect(oldRuntimeCommands.commands).toEqual([]);
		await stageRuntimeCredential(runtime, store, workspaceId, "asset-runtime", [
			CLOUD_RUNTIME_API_ASSETS_CAPABILITY,
		]);
		const commands = await json<{
			commands: ReadonlyArray<{
				text: string;
				attachments?: ReadonlyArray<{ assetId: string }>;
			}>;
		}>(
			await serve(
				runtime,
				`/v1/cloud/workspaces/${workspaceId}/runtime/commands`,
				{ headers: { authorization: "Bearer asset-runtime" } },
			),
			200,
		);
		expect(commands.commands[0]).toMatchObject({
			text: "Inspect this screenshot",
			attachments: [{ assetId: uploaded.asset.assetId }],
		});
		// Web/mobile mailbox ACKs share the URL but must reach their own receipt
		// authority, even while the public API queue has an outstanding command.
		const mailboxAck = await serve(
			runtime,
			`/v1/cloud/workspaces/${workspaceId}/runtime/commands/ack`,
			{
				method: "POST",
				headers: {
					authorization: "Bearer asset-runtime",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					commandId: "browser-command",
					leaseToken: "lease",
					fingerprint: "digest",
					state: "applied",
				}),
			},
		);
		expect(mailboxAck.status).toBe(200);
		expect(takeCloudMailboxDirective(mailboxAck)).toEqual({
			kind: "directive",
			directive: { command: { action: "ack", workspaceId } },
		});
		const downloaded = await json<{ bytes: string }>(
			await serve(
				runtime,
				`/v1/cloud/workspaces/${workspaceId}/runtime/attachments/${uploaded.asset.assetId}`,
				{ headers: { authorization: "Bearer asset-runtime" } },
			),
			200,
		);
		expect(base64UrlToBytes(downloaded.bytes)).toEqual(image);

		const ledger = await json<{
			messages: ReadonlyArray<{
				attachments?: ReadonlyArray<{ assetId: string }>;
			}>;
		}>(
			await serve(runtime, `/v1/api/workspaces/${workspaceId}/messages`, {
				headers: apiHeaders,
			}),
			200,
		);
		expect(ledger.messages[0]?.attachments).toEqual([
			expect.objectContaining({ assetId: uploaded.asset.assetId }),
		]);
		await runtime.dispose();
	});

	test("round-trips a signed Slack image thread through the real API and webhook handlers", async () => {
		const runtime = await makeRuntime();
		const store = await runtime.runPromise(CloudWorkspaceStore);
		await seedReadyProject(runtime, store);
		const secret = await createApiKey(runtime);
		const headers = {
			authorization: `Bearer ${secret}`,
			"content-type": "application/json",
		};
		const webhook = await json<{ secret: string }>(
			await serve(runtime, "/v1/api/webhooks", {
				method: "POST",
				headers,
				body: JSON.stringify({
					url: "https://slack-bot.example.com/zuse/webhook",
				}),
			}),
			201,
		);
		const kv = new Map<string, string>();
		const env: SlackEnv = {
			THREADS: {
				get: async (key) => kv.get(key) ?? null,
				put: async (key, value) => {
					kv.set(key, value);
				},
			},
			SLACK_SIGNING_SECRET: "slack-test-secret",
			SLACK_BOT_TOKEN: "xoxb-test",
			SLACK_USER_TOKEN: "xoxp-test",
			ZUSE_API_KEY: secret,
			ZUSE_API_URL: ISSUER,
			ZUSE_WEBHOOK_SECRET: webhook.secret,
			ZUSE_AGENT: "codex",
			ZUSE_MODEL: "gpt-5",
		};
		const pending: Promise<unknown>[] = [];
		const context = {
			waitUntil: (promise: Promise<unknown>) => {
				pending.push(promise);
			},
		};
		const posts: Array<{ text: string; thread_ts?: string }> = [];
		const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		const file = {
			id: "F1",
			name: "screenshot.png",
			mimetype: "image/png",
			size: image.length,
			url_private_download:
				"https://files.slack.com/files-pri/T-F1/download/image.png",
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const request = new Request(input, init);
				const url = new URL(request.url);
				if (url.origin === ISSUER)
					return runtime.runPromise(handleRequest(request));
				if (url.pathname === "/api/conversations.replies") {
					expect(request.headers.get("authorization")).toBe("Bearer xoxp-test");
					return Response.json({
						ok: true,
						messages: [
							{
								ts: "100.1",
								user: "U1",
								text: "Fix this screen",
								files: [file],
							},
							{ ts: "100.2", user: "U2", text: "The button should be blue" },
						],
					});
				}
				if (url.hostname === "files.slack.com") return new Response(image);
				if (url.pathname === "/api/chat.postMessage") {
					posts.push(await request.json());
					return Response.json({ ok: true, ts: `100.${posts.length + 2}` });
				}
				if (url.origin === "https://slack-bot.example.com")
					return slackWorker.fetch(request, env, context);
				throw new Error(`unexpected request: ${url.origin}${url.pathname}`);
			}),
		);
		const signed = async (path: string, body: string) => {
			const timestamp = String(Math.floor(Date.now() / 1000));
			const key = await crypto.subtle.importKey(
				"raw",
				new TextEncoder().encode(env.SLACK_SIGNING_SECRET),
				{ name: "HMAC", hash: "SHA-256" },
				false,
				["sign"],
			);
			const signature = new Uint8Array(
				await crypto.subtle.sign(
					"HMAC",
					key,
					new TextEncoder().encode(`v0:${timestamp}:${body}`),
				),
			);
			return new Request(`https://slack-bot.example.com${path}`, {
				method: "POST",
				headers: {
					"x-slack-request-timestamp": timestamp,
					"x-slack-signature": `v0=${[...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
				},
				body,
			});
		};
		const interaction = new URLSearchParams({
			payload: JSON.stringify({
				type: "message_action",
				callback_id: "open_in_zuse",
				trigger_id: "trigger-1",
				channel: { id: "C1" },
				message: { ts: "100.2", thread_ts: "100.1" },
			}),
		}).toString();
		expect(
			(
				await slackWorker.fetch(
					await signed("/slack/interactions", interaction),
					env,
					context,
				)
			).status,
		).toBe(200);
		await Promise.all(pending);
		const workspaceId = kv.get("thread:C1:100.1");
		if (workspaceId === undefined)
			throw new Error("Slack import did not create its workspace mapping");
		await stageRuntimeCredential(runtime, store, workspaceId, "slack-runtime", [
			CLOUD_RUNTIME_API_ASSETS_CAPABILITY,
		]);
		const runtimeHeaders = {
			authorization: "Bearer slack-runtime",
			"content-type": "application/json",
		};
		const drain = async () =>
			json<{
				commands: Array<{
					messageId: string;
					turnId: string;
					sessionId: string;
					text: string;
					attachments: Array<{ assetId: string }>;
				}>;
			}>(
				await serve(
					runtime,
					`/v1/cloud/workspaces/${workspaceId}/runtime/commands`,
					{ headers: runtimeHeaders },
				),
				200,
			);
		const command = (await drain()).commands[0];
		if (command === undefined)
			throw new Error("Slack import did not enqueue context");
		expect(command.text).toContain("Fix this screen");
		expect(command.text).toContain("The button should be blue");
		expect(command.attachments).toHaveLength(1);
		const asset = await json<{ bytes: string }>(
			await serve(
				runtime,
				`/v1/cloud/workspaces/${workspaceId}/runtime/attachments/${command.attachments[0]?.assetId}`,
				{ headers: runtimeHeaders },
			),
			200,
		);
		expect(base64UrlToBytes(asset.bytes)).toEqual(image);
		await json(
			await serve(
				runtime,
				`/v1/cloud/workspaces/${workspaceId}/runtime/commands/ack`,
				{
					method: "POST",
					headers: runtimeHeaders,
					body: JSON.stringify({
						messageId: command.messageId,
						turnId: command.turnId,
					}),
				},
			),
			200,
		);
		await json(
			await serve(
				runtime,
				`/v1/cloud/workspaces/${workspaceId}/runtime/turn-events`,
				{
					method: "POST",
					headers: runtimeHeaders,
					body: JSON.stringify({
						sessionId: command.sessionId,
						turnId: command.turnId,
						outcome: "completed",
						settledAt: Date.now(),
						replyText: "Updated the button using your screenshot.",
						replyTruncated: false,
					}),
				},
			),
			200,
		);
		await runtime.runPromise(deliverPendingApiWebhooks);
		expect(posts.at(-1)).toMatchObject({
			thread_ts: "100.1",
			text: expect.stringContaining(
				"Updated the button using your screenshot.",
			),
		});
		const followup = JSON.stringify({
			type: "event_callback",
			event_id: "Ev-file-1",
			event: {
				type: "message",
				subtype: "file_share",
				channel: "C1",
				thread_ts: "100.1",
				files: [file],
			},
		});
		expect(
			(
				await slackWorker.fetch(
					await signed("/slack/events", followup),
					env,
					context,
				)
			).status,
		).toBe(200);
		const next = (await drain()).commands[0];
		expect(next?.attachments).toHaveLength(1);
		// A Slack retry must return the same durable command and attachment.
		expect(
			(
				await slackWorker.fetch(
					await signed("/slack/events", followup),
					env,
					context,
				)
			).status,
		).toBe(200);
		expect((await drain()).commands[0]?.messageId).toBe(next?.messageId);
		await runtime.dispose();
	});

	test("upgrades legacy command ACKs and historical assistant rows", async () => {
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
				headers: { ...apiHeaders, "idempotency-key": "legacy-runtime" },
				body: JSON.stringify({
					prompt: "Legacy launch",
					agent: "codex",
					model: "gpt-5",
				}),
			}),
			201,
		);
		const workspaceId = created.workspace.workspaceId;
		await stageRuntimeCredential(runtime, store, workspaceId, "legacy-secret");
		const workspace = await runtime.runPromise(store.getWorkspace(workspaceId));
		if (workspace === null) throw new Error("workspace missing");
		const runtimeHeaders = {
			authorization: "Bearer legacy-secret",
			"content-type": "application/json",
		};

		const legacyMessageId = "message-legacy-null-turn";
		await runtime.runPromise(
			store.appendApiMessage({
				messageId: legacyMessageId,
				workspaceId,
				accountId: ACCOUNT,
				role: "user",
				sealedContent: await runtime.runPromise(
					sealApiString(
						apiMessageSealContext(ACCOUNT, workspaceId, legacyMessageId),
						"Run on the old runtime",
					),
				),
				status: "pending",
				createdAtMs: Date.now(),
			}),
		);
		const commands = await json<{
			commands: ReadonlyArray<{ messageId: string; turnId: string }>;
		}>(
			await serve(
				runtime,
				`/v1/cloud/workspaces/${workspaceId}/runtime/commands`,
				{ headers: runtimeHeaders },
			),
			200,
		);
		expect(commands.commands).toEqual([
			expect.objectContaining({
				messageId: legacyMessageId,
				turnId: `turn_${legacyMessageId}`,
			}),
		]);
		const legacyAck = await json<{ ok: boolean }>(
			await serve(
				runtime,
				`/v1/cloud/workspaces/${workspaceId}/runtime/commands/ack`,
				{
					method: "POST",
					headers: runtimeHeaders,
					body: JSON.stringify({ messageId: legacyMessageId }),
				},
			),
			200,
		);
		expect(legacyAck.ok).toBe(true);
		const legacyRuntimeTurn = "turn-generated-by-pre-change-runtime";
		await json(
			await serve(
				runtime,
				`/v1/cloud/workspaces/${workspaceId}/runtime/turn-events`,
				{
					method: "POST",
					headers: runtimeHeaders,
					body: JSON.stringify({
						sessionId: workspace.initialSessionId,
						turnId: legacyRuntimeTurn,
						outcome: "completed",
						settledAt: Date.now(),
						replyText: "Legacy command completed",
						replyTruncated: false,
					}),
				},
			),
			200,
		);
		expect(
			(
				await runtime.runPromise(store.listApiMessages(workspaceId, 0, 20))
			).find((message) => message.messageId === legacyMessageId),
		).toMatchObject({ status: "settled", turnId: legacyRuntimeTurn });

		const historicalTurn = "turn-historical-before-receipts";
		const historicalMessageId = `msg_turn_${(
			await runtime.runPromise(sha256Hex(`${workspaceId}\n${historicalTurn}`))
		).slice(0, 40)}`;
		const historicalSettledAt = Date.now() - 1_000;
		await runtime.runPromise(
			store.appendApiMessage({
				messageId: "legacy-launch-unbound",
				workspaceId,
				accountId: ACCOUNT,
				role: "user",
				sealedContent: "legacy-launch-sealed",
				status: "delivered",
				createdAtMs: historicalSettledAt - 100,
			}),
		);
		await runtime.runPromise(
			store.appendApiMessage({
				messageId: historicalMessageId,
				workspaceId,
				accountId: ACCOUNT,
				role: "assistant",
				sealedContent: await runtime.runPromise(
					sealApiString(
						`message\n${ACCOUNT}\n${workspaceId}`,
						"Historical reply",
					),
				),
				turnId: historicalTurn,
				outcome: "completed",
				status: "settled",
				// The original API persisted receipt time, not domain settledAt.
				createdAtMs: historicalSettledAt + 100,
			}),
		);
		const historicalEvent = {
			sessionId: workspace.initialSessionId,
			turnId: historicalTurn,
			outcome: "completed",
			settledAt: historicalSettledAt,
			replyText: "Historical reply",
			replyTruncated: false,
		};
		const adopted = await json<{ recorded: boolean }>(
			await serve(
				runtime,
				`/v1/cloud/workspaces/${workspaceId}/runtime/turn-events`,
				{
					method: "POST",
					headers: runtimeHeaders,
					body: JSON.stringify(historicalEvent),
				},
			),
			200,
		);
		expect(adopted.recorded).toBe(false);
		expect(
			(
				await runtime.runPromise(store.listApiMessages(workspaceId, 0, 20))
			).find((message) => message.messageId === "legacy-launch-unbound"),
		).toMatchObject({ status: "settled", turnId: historicalTurn });
		expect(
			(
				await serve(
					runtime,
					`/v1/cloud/workspaces/${workspaceId}/runtime/turn-events`,
					{
						method: "POST",
						headers: runtimeHeaders,
						body: JSON.stringify({
							...historicalEvent,
							replyText: "Poisoned replay",
						}),
					},
				)
			).status,
		).toBe(409);
		await runtime.dispose();
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

		// The launch turn settles before the runtime accepts FIFO follow-ups.
		await stageRuntimeCredential(runtime, store, workspaceId, "runtime-secret");
		const runtimeHeaders = {
			authorization: "Bearer runtime-secret",
			"content-type": "application/json",
		};
		const workspaceRecord = await runtime.runPromise(
			store.getWorkspace(workspaceId),
		);
		const initialTurnId = String(
			workspaceRecord?.requestConfig.initialTurnId ?? "",
		);
		expect(initialTurnId.length).toBeGreaterThan(0);
		await json(
			await serve(
				runtime,
				`/v1/cloud/workspaces/${workspaceId}/runtime/turn-events`,
				{
					method: "POST",
					headers: runtimeHeaders,
					body: JSON.stringify({
						sessionId: workspaceRecord?.initialSessionId ?? "",
						turnId: initialTurnId,
						outcome: "completed",
						settledAt: Date.now(),
						replyText: "Initial task complete.",
						replyTruncated: false,
					}),
				},
			),
			200,
		);

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
		expect(receipt.seq).toBe(3);
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
		const commands = await json<{
			commands: ReadonlyArray<{
				messageId: string;
				commandId: string;
				turnId: string;
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
		const commandTurnId = commands.commands[0]?.turnId ?? "";
		expect(commandTurnId).toBe(`turn_${receipt.messageId}`);
		await json(
			await serve(
				runtime,
				`/v1/cloud/workspaces/${workspaceId}/runtime/commands/ack`,
				{
					method: "POST",
					headers: runtimeHeaders,
					body: JSON.stringify({
						messageId: receipt.messageId,
						turnId: commandTurnId,
					}),
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

		const turnEvent = {
			sessionId: workspaceRecord?.initialSessionId ?? "",
			turnId: commandTurnId,
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
		expect(
			(
				await serve(
					runtime,
					`/v1/cloud/workspaces/${workspaceId}/runtime/turn-events`,
					{
						method: "POST",
						headers: runtimeHeaders,
						body: JSON.stringify({ ...turnEvent, replyTruncated: true }),
					},
				)
			).status,
		).toBe(409);

		const page = await json<{
			messages: ReadonlyArray<{
				messageId: string;
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
		expect(page.latestSeq).toBe(4);
		expect(page.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(page.messages[0]?.text).toBe("Fix the login bug");
		expect(page.messages[0]?.status).toBe("settled");
		expect(page.messages[1]?.text).toBe("Initial task complete.");
		expect(page.messages[2]?.status).toBe("settled");
		expect(page.messages[3]?.text).toBe("Done! The login bug is fixed.");
		expect(page.messages[3]?.turnId).toBe(commandTurnId);

		const status = await json<{
			workspace: { agentStatus: string; lastTurn: { turnId: string } | null };
		}>(
			await serve(runtime, `/v1/api/workspaces/${workspaceId}`, {
				headers: apiHeaders,
			}),
			200,
		);
		expect(status.workspace.agentStatus).toBe("idle");
		expect(status.workspace.lastTurn?.turnId).toBe(commandTurnId);

		// Retrying a terminal message after a later pause is a read-only receipt
		// replay: it must not wake billable compute with no pending command.
		const settledWorkspace = await runtime.runPromise(
			store.getWorkspace(workspaceId),
		);
		if (settledWorkspace === null) throw new Error("workspace missing");
		await runtime.runPromise(
			store.saveWorkspace({
				...settledWorkspace,
				state: "paused",
				desiredState: "paused",
				statusCode: "paused",
				revision: settledWorkspace.revision + 1,
				updatedAtMs: settledWorkspace.updatedAtMs + 1,
			}),
		);
		const terminalReplay = await json<{
			status: string;
			resumeTriggered: boolean;
		}>(
			await serve(runtime, `/v1/api/workspaces/${workspaceId}/messages`, {
				method: "POST",
				headers: { ...apiHeaders, "idempotency-key": "m1" },
				body: JSON.stringify({ text: "Also update the docs" }),
			}),
			200,
		);
		expect(terminalReplay).toMatchObject({
			status: "delivered",
			resumeTriggered: false,
		});
		expect(
			(await runtime.runPromise(store.getWorkspace(workspaceId)))?.desiredState,
		).toBe("paused");
		const pausedWorkspace = await runtime.runPromise(
			store.getWorkspace(workspaceId),
		);
		if (pausedWorkspace === null) throw new Error("workspace missing");
		await runtime.runPromise(
			store.saveWorkspace({
				...pausedWorkspace,
				state: "failed",
				statusCode: "runtime-failed",
				revision: pausedWorkspace.revision + 1,
				updatedAtMs: pausedWorkspace.updatedAtMs + 1,
			}),
		);
		// A terminal workspace still permits replaying an already-settled receipt.
		expect(
			(
				await serve(runtime, `/v1/api/workspaces/${workspaceId}/messages`, {
					method: "POST",
					headers: { ...apiHeaders, "idempotency-key": "m1" },
					body: JSON.stringify({ text: "Also update the docs" }),
				})
			).status,
		).toBe(200);

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
			messageId: string;
			reply: { text: string };
		};
		expect(payload.type).toBe("workspace.turn.completed");
		expect(payload.workspaceId).toBe(workspaceId);
		expect(payload.messageId).toBe(page.messages[3]?.messageId);
		expect(payload).not.toHaveProperty("messageSeq");
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

	test("does not persist a paused-workspace command when billing denies resume", async () => {
		const runtime = await makeRuntime(BetaAccessAllowAll, true);
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
				headers: { ...apiHeaders, "idempotency-key": "billing-task" },
				body: JSON.stringify({
					prompt: "Prepare the change",
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
		const nowMs = Date.now();
		const machineStore = await runtime.runPromise(MachineStore);
		const entitlement = (
			await runtime.runPromise(machineStore.listEntitlements(ACCOUNT))
		).find((item) => item.kind === "cloud-workspace");
		if (entitlement === undefined) throw new Error("entitlement missing");
		await runtime.runPromise(
			machineStore.upsertEntitlement({
				...entitlement,
				provider: "polar",
				providerSubscriptionId: "subscription_billing_hold",
				status: "grace",
				updatedAtMs: nowMs,
			}),
		);

		const denied = await serve(
			runtime,
			`/v1/api/workspaces/${workspaceId}/messages`,
			{
				method: "POST",
				headers: { ...apiHeaders, "idempotency-key": "must-not-queue" },
				body: JSON.stringify({ text: "This must not run later" }),
			},
		);
		expect(denied.status).toBe(403);
		expect(
			await runtime.runPromise(store.listApiMessages(workspaceId, 0, 10)),
		).toHaveLength(1);
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
		const machineStore = await runtime.runPromise(MachineStore);
		const entitlementNow = Date.now();
		await runtime.runPromise(
			machineStore.upsertEntitlement({
				entitlementId: "foreign-cloud-workspace",
				accountId: "user_b",
				kind: "cloud-workspace",
				offerId: "cloud-workspace-standard-v1",
				provider: "manual",
				status: "active",
				createdAtMs: entitlementNow,
				updatedAtMs: entitlementNow,
			}),
		);
		const foreign = await serve(runtime, `/v1/api/workspaces/${workspaceId}`, {
			headers: { authorization: `Bearer ${foreignKey.secret}` },
		});
		expect(foreign.status).toBe(404);
	});
});
