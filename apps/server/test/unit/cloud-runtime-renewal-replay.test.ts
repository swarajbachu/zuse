import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { importJWK, jwtVerify } from "jose";
import { expect, it, vi } from "vitest";
import { openCloudRuntimeIdentity } from "../../src/api/cloud-runtime-identity.ts";
import { renewRuntimeCredential } from "../../src/api/cloud-workspace-runtime.ts";

it("replays a server-committed renewal after response loss and process restart with the old bearer and identical proof key/request ID", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-renewal-replay-"));
	vi.stubEnv("ZUSE_USER_DATA", directory);
	const binding = {
		directory,
		workspaceId: "workspace-1",
		apiUrl: "https://api.test",
		storageIncarnationId: "storage-1",
		expectedGeneration: 4,
	};
	const bootstrap = {
		zuseAccountId: "account-1",
		workspaceId: binding.workspaceId,
		runtimeGeneration: 4,
		runtimeCredential: "expired-bearer",
		runtimeCredentialExpiresAt: 1,
		gatewayEpoch: 2,
	};
	const config = {
		workspaceId: binding.workspaceId,
		apiUrl: binding.apiUrl,
		localPort: 47837,
		workspaceRoot: "/repos/test",
	};
	const state = () => ({
		credential: bootstrap.runtimeCredential,
		expiresAt: 1,
		generation: 4,
		gatewayEpoch: 2,
	});
	try {
		const first = await openCloudRuntimeIdentity({
			...binding,
			bootToken: "spent-boot",
		});
		await first.commitBootstrap(bootstrap);
		let committed!: () => void;
		const serverCommitted = new Promise<void>((resolve) => {
			committed = resolve;
		});
		const fetcher = vi.fn().mockImplementationOnce(() => {
			committed();
			// The server has rotated. Its response is lost and the runtime then exits.
			return new Promise<Response>(() => {});
		});
		vi.stubGlobal("fetch", fetcher);
		await Effect.runPromise(
			Effect.gen(function* () {
				const fiber = yield* renewRuntimeCredential({
					config,
					signingPrivateKey: first.signingPrivateKey,
					state: state(),
					requestId: "rotation-receipt-1",
					persistence: {
						begin: first.beginRenewal,
						commit: async () => {
							throw new Error("response never arrived");
						},
					},
				}).pipe(Effect.forkChild);
				yield* Effect.promise(() => serverCommitted);
				yield* Fiber.interrupt(fiber);
			}),
		);
		const resumed = await openCloudRuntimeIdentity(binding);
		expect(resumed.pendingRenewalId).toBe("rotation-receipt-1");
		expect(resumed.bootstrap).toEqual(bootstrap);
		const expiresAt = Date.now() + 60_000;
		fetcher.mockResolvedValue(
			Response.json({
				workspaceId: binding.workspaceId,
				requestId: "rotation-receipt-1",
				runtimeCredential: "committed-new-bearer",
				expiresAt,
				generation: 4,
				gatewayEpoch: 2,
			}),
		);
		const live = state();
		await Effect.runPromise(
			renewRuntimeCredential({
				config,
				signingPrivateKey: resumed.signingPrivateKey,
				state: live,
				requestId: "must-not-use-new-id",
				persistence: {
					begin: resumed.beginRenewal,
					commit: (result) =>
						resumed.commitRenewal({
							...bootstrap,
							runtimeCredential: result.runtimeCredential,
							runtimeCredentialExpiresAt: result.expiresAt,
						}),
				},
			}),
		);
		expect(fetcher).toHaveBeenCalledTimes(2);
		for (const [, request] of fetcher.mock.calls) {
			expect(request.headers.authorization).toBe("Bearer expired-bearer");
			const body = JSON.parse(request.body);
			expect(body.requestId).toBe("rotation-receipt-1");
			const proof = await jwtVerify(
				body.proof,
				await importJWK(JSON.parse(first.signingPublicJwk), "EdDSA"),
				{ audience: binding.apiUrl },
			);
			expect(proof.payload).toMatchObject({
				workspaceId: binding.workspaceId,
				generation: 4,
				gatewayEpoch: 2,
				requestId: "rotation-receipt-1",
			});
		}
		expect(live.credential).toBe("committed-new-bearer");
		const durable = await openCloudRuntimeIdentity(binding);
		expect(durable.pendingRenewalId).toBeNull();
		expect(durable.bootstrap).toMatchObject({
			runtimeCredential: "committed-new-bearer",
		});
	} finally {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	}
});
