import { EnvironmentId } from "@zuse/contracts";
import { Effect, Fiber, Layer, Result } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it, vi } from "vitest";
import { AccountAccessService } from "../../src/account-access/service.ts";
import {
	ApiLinkError,
	ApiLinkService,
	makeApiLinkServiceLive,
	retireUntilRetired,
} from "../../src/api/api-link-service.ts";
import { ManagedTunnelRuntime } from "../../src/api/managed-tunnel-runtime.ts";
import { AuthService } from "../../src/auth/services/auth-service.ts";
import { CollaborationService } from "../../src/collaboration/services/collaboration-service.ts";
import {
	LanAuthConfig,
	LanAuthService,
} from "../../src/lan-auth/services/lan-auth-service.ts";
import { TelemetryStore } from "../../src/observability/telemetry-store.ts";

// Fail on any unexpected dependency access, rather than silently accepting a new boot side effect.
const dependency = <T extends object>(methods: Partial<T>): T =>
	new Proxy(methods, {
		get(target, key) {
			if (!(key in target))
				throw new Error(`Unexpected startup dependency: ${String(key)}`);
			return Reflect.get(target, key);
		},
	}) as T;

it("does not resume a saved dev registration, tunnel, or heartbeat on boot", async () => {
	const getApiConfig = vi.fn(() =>
		Effect.succeed({
			apiUrl: "https://api-staging.zuse.sh",
			apiIssuer: "staging",
			environmentId: EnvironmentId.make("old-dev-instance"),
			environmentCredential: "test-credential",
			label: "My Mac",
			connectorToken: "saved-tunnel",
			tunnelHostname: "test.invalid",
			mintPublicKey: undefined,
		}),
	);
	const start = vi.fn(() => Effect.void);
	const layer = makeApiLinkServiceLive({ resumeExistingLink: false }).pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(
					CollaborationService,
					dependency<CollaborationService["Service"]>({}),
				),
				Layer.succeed(LanAuthConfig, {
					policy: "protected",
					advertisedHost: null,
					port: 8788,
					pairingBootstrap: false,
				}),
				Layer.succeed(
					LanAuthService,
					dependency<LanAuthService["Service"]>({ getApiConfig }),
				),
				Layer.succeed(AuthService, dependency<AuthService["Service"]>({})),
				Layer.succeed(
					AccountAccessService,
					dependency<AccountAccessService["Service"]>({}),
				),
				Layer.succeed(ManagedTunnelRuntime, { start, stop: () => Effect.void }),
				Layer.succeed(
					TelemetryStore,
					dependency<TelemetryStore["Service"]>({
						record: () => undefined,
						runId: "test-startup",
					}),
				),
			),
		),
	);
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* ApiLinkService;
			}).pipe(Effect.provide(layer)),
		),
	);
	expect(getApiConfig).not.toHaveBeenCalled();
	expect(start).not.toHaveBeenCalled();
});

describe("retiring a saved registration", () => {
	const savedConfig = {
		apiUrl: "https://api.example.test",
		apiIssuer: "test",
		environmentId: EnvironmentId.make("old-dev-instance"),
		environmentCredential: "test-credential",
		label: "My Mac",
		connectorToken: "saved-tunnel",
		tunnelHostname: "test.invalid",
		mintPublicKey: undefined,
	};

	const run = async (input: {
		readonly config: typeof savedConfig | null;
		readonly signedIn?: boolean;
		readonly response?: Response;
	}) => {
		let config = input.config;
		const clearApiConfig = vi.fn(() =>
			Effect.sync(() => {
				config = null;
			}),
		);
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				requests.push({ url, init });
				return input.response ?? Response.json({ ok: true });
			}),
		);
		const layer = makeApiLinkServiceLive({ resumeExistingLink: false }).pipe(
			Layer.provide(
				Layer.mergeAll(
					Layer.succeed(
						CollaborationService,
						dependency<CollaborationService["Service"]>({}),
					),
					Layer.succeed(LanAuthConfig, {
						policy: "protected",
						advertisedHost: null,
						port: 8788,
						pairingBootstrap: false,
					}),
					Layer.succeed(
						LanAuthService,
						dependency<LanAuthService["Service"]>({
							getApiConfig: () => Effect.succeed(config),
							clearApiConfig,
						} as Partial<LanAuthService["Service"]>),
					),
					Layer.succeed(
						AuthService,
						dependency<AuthService["Service"]>({
							getAccessToken: () =>
								input.signedIn === false
									? Effect.fail({ _tag: "AuthTokenError" } as never)
									: Effect.succeed("account-token"),
						}),
					),
					Layer.succeed(
						AccountAccessService,
						dependency<AccountAccessService["Service"]>({}),
					),
					Layer.succeed(ManagedTunnelRuntime, {
						start: () => Effect.void,
						stop: () => Effect.void,
					}),
					Layer.succeed(
						TelemetryStore,
						dependency<TelemetryStore["Service"]>({
							record: () => undefined,
							runId: "test-retire",
						}),
					),
				),
			),
		);
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const api = yield* ApiLinkService;
					return yield* api.retire().pipe(Effect.result);
				}).pipe(Effect.provide(layer)),
			),
		);
		vi.unstubAllGlobals();
		return { result, requests, clearApiConfig };
	};

	it("removes the computer from the account, then forgets it locally", async () => {
		const { result, requests, clearApiConfig } = await run({
			config: savedConfig,
		});
		expect(Result.isSuccess(result) && result.success).toBe(true);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(
			"https://api.example.test/v1/client/environment-unlink",
		);
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			environmentId: "old-dev-instance",
		});
		expect(clearApiConfig).toHaveBeenCalledOnce();
	});

	it("treats a computer the account no longer has as already retired", async () => {
		const { result, clearApiConfig } = await run({
			config: savedConfig,
			response: Response.json({ error: "not_found" }, { status: 404 }),
		});
		expect(Result.isSuccess(result)).toBe(true);
		expect(clearApiConfig).toHaveBeenCalledOnce();
	});

	it("keeps the local link when the account could not remove it", async () => {
		const failed = await run({
			config: savedConfig,
			response: Response.json({ error: "unavailable" }, { status: 503 }),
		});
		expect(Result.isFailure(failed.result)).toBe(true);
		expect(failed.clearApiConfig).not.toHaveBeenCalled();

		const signedOut = await run({ config: savedConfig, signedIn: false });
		expect(Result.isFailure(signedOut.result)).toBe(true);
		expect(signedOut.requests).toHaveLength(0);
		expect(signedOut.clearApiConfig).not.toHaveBeenCalled();
	});

	it("does nothing when this runtime was never linked", async () => {
		const { result, requests } = await run({ config: null });
		expect(Result.isSuccess(result) && result.success).toBe(false);
		expect(requests).toHaveLength(0);
	});

	it("retries until the account confirms the removal", async () => {
		let attempts = 0;
		await Effect.runPromise(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					retireUntilRetired(
						Effect.suspend(() =>
							++attempts < 3
								? Effect.fail(new ApiLinkError({ reason: "signed_out" }))
								: Effect.succeed(true),
						),
					),
				);
				yield* TestClock.adjust("1 minute");
				yield* Fiber.join(fiber);
			}).pipe(Effect.provide(TestClock.layer())),
		);
		expect(attempts).toBe(3);
	});
});
