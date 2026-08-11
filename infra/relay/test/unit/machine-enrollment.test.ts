import { BillingProvidersManual } from "@zuse/billing-providers";
import { MachineProvidersFake } from "@zuse/machine-providers/testing";
import { SandboxProvidersFake } from "@zuse/sandbox-providers/testing";
import { Effect, Layer, Redacted, Ref } from "effect";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, test } from "vitest";

import * as Config from "../../src/config.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { routeMachineRequest } from "../../src/machine-routes.ts";
import { MachineStore, MachineStoreMemory } from "../../src/machine-store.ts";
import {
	ManagedTunnelProvider,
	type ManagedTunnelProviderApi,
} from "../../src/managed-tunnel.ts";
import { RelayStore, RelayStoreMemory } from "../../src/store.ts";
import { WorkosVerifierTest } from "../../src/workos.ts";

const RELAY_ISSUER = "https://relay.test";
const TOKEN = "zenr_test-secret";
const ENVIRONMENT_ID = "env_cloud_1";

const testTunnel: ManagedTunnelProviderApi = {
	enabled: true,
	provision: () =>
		Effect.succeed({
			tunnelHostname: "machine.test",
			tunnelId: "tunnel_1",
			connectorToken: "connector_1",
		}),
	deprovision: () => Effect.void,
};

const configLayer = Config.layer({
	relayIssuer: RELAY_ISSUER,
	workosJwksUrl: "https://unused.test/jwks",
	workosIssuer: "https://unused.test",
	mintPrivateKey: Redacted.make("{}"),
	mintPublicKey: '{"kty":"OKP"}',
});

const makeTestLayer = (
	machineStore: Layer.Layer<MachineStore>,
	tunnel: ManagedTunnelProviderApi,
) =>
	Layer.mergeAll(
		configLayer,
		WorkosVerifierTest,
		machineStore,
		MachineProvidersFake,
		SandboxProvidersFake,
		BillingProvidersManual,
		RelayStoreMemory,
		Layer.succeed(ManagedTunnelProvider, tunnel),
	);

const testLayer = makeTestLayer(MachineStoreMemory, testTunnel);

const failFirstCompareAndSet = Layer.effect(
	MachineStore,
	Effect.gen(function* () {
		const store = yield* MachineStore;
		const failNext = yield* Ref.make(true);
		return {
			...store,
			compareAndSetMachine: (machine, expectedRevision) =>
				Ref.modify(failNext, (shouldFail) => [shouldFail, false]).pipe(
					Effect.flatMap((shouldFail) =>
						shouldFail
							? Effect.succeed(false)
							: store.compareAndSetMachine(machine, expectedRevision),
					),
				),
		};
	}),
).pipe(Layer.provide(MachineStoreMemory));

const compareAndSetRaceLayer = makeTestLayer(
	failFirstCompareAndSet,
	testTunnel,
);

const proofFor = async (
	privateKey: CryptoKey,
	environmentId = ENVIRONMENT_ID,
): Promise<string> =>
	new SignJWT({ challenge: TOKEN, environmentId })
		.setProtectedHeader({ alg: "EdDSA", typ: "environment-link-proof+jwt" })
		.setAudience(RELAY_ISSUER)
		.setIssuedAt()
		.setExpirationTime("5m")
		.sign(privateKey);

const enrollRequest = (input: {
	readonly publicJwk: string;
	readonly proof: string;
}): Request =>
	new Request(`${RELAY_ISSUER}/v1/machines/enroll`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${TOKEN}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			machineId: "machine_1",
			environmentId: ENVIRONMENT_ID,
			environmentPublicKey: input.publicJwk,
			proof: input.proof,
			endpoint: {
				httpBaseUrl: "http://127.0.0.1:47837",
				wsBaseUrl: "ws://127.0.0.1:47837/rpc",
			},
			origin: {
				localHttpHost: "127.0.0.1",
				localHttpPort: 47837,
			},
			label: "Build box",
		}),
	});

const bootStatusRequest = (
	phase: "developer-tools-installed" | "failed" | "zuse-started",
): Request =>
	new Request(`${RELAY_ISSUER}/v1/machines/machine_1/boot-status`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${TOKEN}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ phase }),
	});

const safeRoute = (request: Request) =>
	routeMachineRequest(request).pipe(
		Effect.catch((error) =>
			Effect.succeed(new Response(null, { status: error.status })),
		),
	);

const seedEnrollment = Effect.fn("seedEnrollment")(function* (
	nowMs: number,
	options: {
		readonly offerId?: string;
		readonly providerServerId?: string;
		readonly providerEndpointHttpBaseUrl?: string;
		readonly providerEndpointWsBaseUrl?: string;
	} = {},
) {
	const store = yield* MachineStore;
	const offerId = options.offerId ?? "persistent-standard-v1";
	yield* store.upsertEntitlement({
		entitlementId: "ent_1",
		accountId: "user_a",
		kind: "persistent-machine",
		offerId,
		provider: "manual",
		status: "active",
		paidThroughMs: nowMs + 30 * 24 * 60 * 60 * 1_000,
		createdAtMs: nowMs,
		updatedAtMs: nowMs,
	});
	const created = yield* store.createMachine({
		accountId: "user_a",
		offerId,
		sameKindOfferIds: [offerId],
		idempotencyKey: "create_1",
		machineId: "machine_1",
		provider: "fake",
		providerLabel: "zuse-machine_1",
		nowMs,
	});
	if (created.kind !== "created") return yield* Effect.die(created.kind);
	const machine = {
		...created.machine,
		providerServerId: options.providerServerId,
		providerEndpointHttpBaseUrl: options.providerEndpointHttpBaseUrl,
		providerEndpointWsBaseUrl: options.providerEndpointWsBaseUrl,
		state: "enrolling" as const,
		statusCode: "enrollment-pending" as const,
		enrollmentTokenHash: yield* sha256Hex(TOKEN),
		enrollmentExpiresAtMs: nowMs + 30 * 60 * 1_000,
	};
	yield* store.saveMachine(machine);
	return machine;
});

describe("machine enrollment", () => {
	test("does not become ready until both enrollment and Zuse startup complete", async () => {
		const key = await generateKeyPair("EdDSA", { extractable: true });
		const publicJwk = JSON.stringify(await exportJWK(key.publicKey));
		const proof = await proofFor(key.privateKey);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				yield* seedEnrollment(Date.now());
				const enrolled = yield* safeRoute(enrollRequest({ publicJwk, proof }));
				const machineStore = yield* MachineStore;
				const beforeStartup = yield* machineStore.getMachine("machine_1");
				const toolsInstalled = yield* safeRoute(
					bootStatusRequest("developer-tools-installed"),
				);
				const afterTools = yield* machineStore.getMachine("machine_1");
				const started = yield* safeRoute(bootStatusRequest("zuse-started"));
				const delayedFailure = yield* safeRoute(bootStatusRequest("failed"));
				return {
					enrolled,
					beforeStartup,
					toolsInstalled,
					afterTools,
					started,
					delayedFailure,
					afterStartup: yield* machineStore.getMachine("machine_1"),
				};
			}).pipe(Effect.provide(compareAndSetRaceLayer)),
		);

		expect(result.enrolled?.status).toBe(200);
		expect(result.beforeStartup?.state).toBe("enrolling");
		expect(result.beforeStartup?.statusCode).toBe("enrollment-pending");
		expect(result.toolsInstalled?.status).toBe(200);
		expect(result.afterTools?.state).toBe("enrolling");
		expect(result.started?.status).toBe(200);
		expect(result.delayedFailure?.status).toBe(200);
		expect(result.afterStartup?.state).toBe("ready");
		expect(result.afterStartup?.statusCode).toBe("ready");
	});

	test("allows a same-key retry but rejects another identity and expiry", async () => {
		const key = await generateKeyPair("EdDSA", { extractable: true });
		const otherKey = await generateKeyPair("EdDSA", { extractable: true });
		const publicJwk = JSON.stringify(await exportJWK(key.publicKey));
		const otherPublicJwk = JSON.stringify(await exportJWK(otherKey.publicKey));
		const proof = await proofFor(key.privateKey);
		const otherProof = await proofFor(otherKey.privateKey);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				yield* seedEnrollment(Date.now());
				const machineStore = yield* MachineStore;
				const bootstrapped = yield* machineStore.getMachine("machine_1");
				if (bootstrapped === null) return yield* Effect.die("missing machine");
				yield* machineStore.saveMachine({
					...bootstrapped,
					bootPhase: "zuse-started",
				});
				const first = yield* safeRoute(enrollRequest({ publicJwk, proof }));
				const retry = yield* safeRoute(enrollRequest({ publicJwk, proof }));
				const wrongKey = yield* safeRoute(
					enrollRequest({ publicJwk: otherPublicJwk, proof: otherProof }),
				);

				const machine = yield* machineStore.getMachine("machine_1");
				if (machine === null) return yield* Effect.die("missing machine");
				yield* machineStore.saveMachine({
					...machine,
					state: "destroying",
					desiredState: "destroyed",
				});
				const afterDestroy = yield* safeRoute(
					enrollRequest({ publicJwk, proof }),
				);
				yield* machineStore.saveMachine({
					...machine,
					enrollmentExpiresAtMs: Date.now() - 1,
				});
				const expired = yield* safeRoute(enrollRequest({ publicJwk, proof }));
				const relayStore = yield* RelayStore;
				return {
					first,
					retry,
					wrongKey,
					afterDestroy,
					expired,
					machine: yield* machineStore.getMachine("machine_1"),
					environment: yield* relayStore.getEnvironment(ENVIRONMENT_ID),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.first?.status).toBe(200);
		expect(result.retry?.status).toBe(200);
		expect(result.wrongKey?.status).toBe(409);
		expect(result.afterDestroy?.status).toBe(410);
		expect(result.expired?.status).toBe(410);
		expect(result.machine?.state).toBe("ready");
		expect(result.environment?.providerKind).toBe("cloud");
	});

	test("does not replace an existing same-account environment identity", async () => {
		const machineKey = await generateKeyPair("EdDSA", { extractable: true });
		const existingKey = await generateKeyPair("EdDSA", { extractable: true });
		const machinePublicJwk = JSON.stringify(
			await exportJWK(machineKey.publicKey),
		);
		const existingPublicJwk = JSON.stringify(
			await exportJWK(existingKey.publicKey),
		);
		const proof = await proofFor(machineKey.privateKey);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				yield* seedEnrollment(Date.now());
				const relayStore = yield* RelayStore;
				yield* relayStore.registerEnvironment(
					{
						environmentId: ENVIRONMENT_ID,
						accountId: "user_a",
						providerKind: "desktop",
						environmentPublicKey: existingPublicJwk,
						httpBaseUrl: "http://127.0.0.1:4000",
						wsBaseUrl: "ws://127.0.0.1:4000/rpc",
						linkedAtMs: Date.now(),
					},
					5,
					"replace-same-account",
				);

				const response = yield* safeRoute(
					enrollRequest({ publicJwk: machinePublicJwk, proof }),
				);
				return {
					response,
					environment: yield* relayStore.getEnvironment(ENVIRONMENT_ID),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.response?.status).toBe(409);
		expect(result.environment?.providerKind).toBe("desktop");
		expect(result.environment?.environmentPublicKey).toBe(existingPublicJwk);
	});

	test("enrolls an entitled machine independently of the hosted computer limit", async () => {
		const key = await generateKeyPair("EdDSA", { extractable: true });
		const publicJwk = JSON.stringify(await exportJWK(key.publicKey));
		const proof = await proofFor(key.privateKey);

		const response = await Effect.runPromise(
			Effect.gen(function* () {
				yield* seedEnrollment(Date.now());
				const relayStore = yield* RelayStore;
				for (let index = 0; index < 5; index += 1) {
					yield* relayStore.registerEnvironment(
						{
							environmentId: `env_existing_${index}`,
							accountId: "user_a",
							providerKind: "desktop",
							environmentPublicKey: `key_${index}`,
							httpBaseUrl: `http://127.0.0.1:${5000 + index}`,
							wsBaseUrl: `ws://127.0.0.1:${5000 + index}/rpc`,
							linkedAtMs: Date.now(),
						},
						5,
						"replace-same-account",
					);
				}
				return yield* safeRoute(enrollRequest({ publicJwk, proof }));
			}).pipe(Effect.provide(testLayer)),
		);

		expect(response?.status).toBe(200);
	});
});
