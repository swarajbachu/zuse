import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber } from "effect";
import { importJWK, jwtVerify } from "jose";
import { expect, it, vi } from "vitest";
import { openCloudRuntimeIdentity } from "../../src/api/cloud-runtime-identity.ts";
import {
	CloudWorkspaceRuntimeError,
	makeCloudMailboxLeaseRequest,
	makeRuntimeCredentialRefresh,
	renewRuntimeCredential,
} from "../../src/api/cloud-workspace-runtime.ts";

it.each([
	"same process",
	"process restart",
])("replays a server-committed renewal after response loss (%s) with the old bearer and identical proof key/request ID", async (recovery) => {
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
		const resumed =
			recovery === "same process"
				? first
				: await openCloudRuntimeIdentity(binding);
		expect(resumed.pendingRenewalId).toBe("rotation-receipt-1");
		expect((await openCloudRuntimeIdentity(binding)).bootstrap).toEqual(
			bootstrap,
		);
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

it("keeps the live bearer aligned with the durable identity when interrupted during renewal commit", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-renewal-commit-"));
	vi.stubEnv("ZUSE_USER_DATA", directory);
	const binding = {
		directory,
		workspaceId: "workspace-commit",
		apiUrl: "https://api.test",
		storageIncarnationId: "storage-commit",
		expectedGeneration: 4,
	};
	const bootstrap = {
		zuseAccountId: "account-1",
		workspaceId: binding.workspaceId,
		runtimeGeneration: 4,
		runtimeCredential: "old-bearer",
		runtimeCredentialExpiresAt: Date.now() + 60_000,
		gatewayEpoch: 2,
	};
	const live = {
		credential: bootstrap.runtimeCredential,
		gatewayCredential: "old-gateway-bearer" as string | undefined,
		expiresAt: bootstrap.runtimeCredentialExpiresAt,
		generation: 4,
		gatewayEpoch: 2,
	};
	try {
		const identity = await openCloudRuntimeIdentity({
			...binding,
			bootToken: "boot",
		});
		await identity.commitBootstrap(bootstrap);
		const expiresAt = Date.now() + 120_000;
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					workspaceId: binding.workspaceId,
					requestId: "commit-rotation",
					runtimeCredential: "fresh-bearer",
					expiresAt,
					generation: 4,
					gatewayEpoch: 2,
				}),
			),
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const committed = yield* Deferred.make<void>();
				let release!: () => void;
				const commitReturn = new Promise<void>((resolve) => {
					release = resolve;
				});
				const renew = renewRuntimeCredential({
					config: {
						workspaceId: binding.workspaceId,
						apiUrl: binding.apiUrl,
						localPort: 47837,
						workspaceRoot: "/repos/test",
					},
					signingPrivateKey: identity.signingPrivateKey,
					state: live,
					requestId: "commit-rotation",
					persistence: {
						begin: identity.beginRenewal,
						commit: async (result) => {
							await identity.commitRenewal({
								...bootstrap,
								runtimeCredential: result.runtimeCredential,
								runtimeCredentialExpiresAt: result.expiresAt,
							});
							await Effect.runPromise(Deferred.succeed(committed, undefined));
							await commitReturn;
						},
					},
				});
				const refresh = yield* makeRuntimeCredentialRefresh({
					state: live,
					pending: () => identity.pendingRenewalId !== null,
					renew,
				});
				const renewal = yield* refresh.renew.pipe(Effect.forkChild);
				yield* Deferred.await(committed);
				const interruption = yield* Fiber.interrupt(renewal).pipe(
					Effect.forkChild,
				);
				yield* Effect.yieldNow;
				release();
				yield* Fiber.join(interruption);
				// Exercise the same refresh gate and lease path used by a waiting message.
				const page = yield* makeCloudMailboxLeaseRequest({
					ensureCredential: refresh.ensure,
					request: () =>
						live.credential === "fresh-bearer"
							? Effect.succeed({
									leases: [],
									mailboxRevision: 1,
									waited: false,
								})
							: Effect.fail(
									new CloudWorkspaceRuntimeError({
										reason: "workspace_runtime_rejected",
										httpStatus: 401,
									}),
								),
				});
				expect(page.mailboxRevision).toBe(1);
				expect(fetch).toHaveBeenCalledTimes(1);
			}),
		);
		const durable = await openCloudRuntimeIdentity(binding);
		expect(durable.pendingRenewalId).toBeNull();
		expect(durable.bootstrap).toMatchObject({
			runtimeCredential: "fresh-bearer",
		});
		expect(live.credential).toBe("fresh-bearer");
		expect(live.expiresAt).toBe(expiresAt);
		expect(live.gatewayCredential).toBeUndefined();
	} finally {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	}
});
