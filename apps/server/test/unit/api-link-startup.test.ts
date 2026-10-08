import { EnvironmentId } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import { expect, it, vi } from "vitest";
import { AccountAccessService } from "../../src/account-access/service.ts";
import {
	ApiLinkService,
	makeApiLinkServiceLive,
} from "../../src/api/api-link-service.ts";
import { ManagedTunnelRuntime } from "../../src/api/managed-tunnel-runtime.ts";
import { AuthService } from "../../src/auth/services/auth-service.ts";
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
