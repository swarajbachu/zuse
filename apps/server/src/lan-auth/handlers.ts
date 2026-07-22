import {
	ConnectAuthError,
	EnvironmentDescriptor,
	EnvironmentEndpoint,
	MemoizeRpcs,
	NearbyPairingRequest,
	PairingError,
	PairingStartResult,
	WIRE_PROTOCOL_VERSION,
	WireProtocolRejected,
	WireWelcome,
} from "@zuse/contracts";
import { Effect, Layer } from "effect";

import { buildAdvertisedEndpoints } from "./advertised-endpoints.ts";
import { defaultEnvironmentLabel } from "./environment-label.ts";
import { LanAuthConfig, LanAuthService } from "./services/lan-auth-service.ts";

const toPairingError = (cause: unknown): PairingError =>
	new PairingError({
		reason:
			cause instanceof Error && cause.message.length > 0
				? cause.message
				: String(cause),
	});

export const makePairingStartResult = (result: {
	readonly code: string;
	readonly expiresAt: Date;
	readonly pairingUrl: string;
	readonly browserUrl: string;
	readonly qrText: string;
}): PairingStartResult => PairingStartResult.make(result);

const PairingStart = MemoizeRpcs.toLayerHandler("pairing.start", () =>
	Effect.gen(function* () {
		const auth = yield* LanAuthService;
		const result = yield* auth.createPairingCode();
		return makePairingStartResult(result);
	}).pipe(Effect.mapError(toPairingError)),
);

const PairingListTokens = MemoizeRpcs.toLayerHandler("pairing.listTokens", () =>
	Effect.gen(function* () {
		const auth = yield* LanAuthService;
		return yield* auth.listTokens();
	}).pipe(Effect.mapError(toPairingError)),
);

const PairingRevokeToken = MemoizeRpcs.toLayerHandler(
	"pairing.revokeToken",
	({ tokenId }) =>
		Effect.gen(function* () {
			const auth = yield* LanAuthService;
			yield* auth.revokeToken(tokenId);
		}).pipe(Effect.mapError(toPairingError)),
);

const PairingListNearbyRequests = MemoizeRpcs.toLayerHandler(
	"pairing.listNearbyRequests",
	() =>
		Effect.gen(function* () {
			const auth = yield* LanAuthService;
			const requests = yield* auth.listNearbyPairingRequests();
			return requests.map((request) => NearbyPairingRequest.make(request));
		}).pipe(Effect.mapError(toPairingError)),
);

const PairingResolveNearbyRequest = MemoizeRpcs.toLayerHandler(
	"pairing.resolveNearbyRequest",
	(input) =>
		Effect.gen(function* () {
			const auth = yield* LanAuthService;
			return yield* auth.resolveNearbyPairingRequest(input);
		}).pipe(Effect.mapError(toPairingError)),
);

const ConnectHandshake = MemoizeRpcs.toLayerHandler(
	"connect.handshake",
	({ protocolVersion }) =>
		protocolVersion === WIRE_PROTOCOL_VERSION
			? Effect.succeed(
					WireWelcome.make({ protocolVersion: WIRE_PROTOCOL_VERSION }),
				)
			: Effect.fail(
					new WireProtocolRejected({
						expectedVersion: WIRE_PROTOCOL_VERSION,
						receivedVersion: protocolVersion,
					}),
				),
);

const ConnectDescribe = MemoizeRpcs.toLayerHandler("connect.describe", () =>
	Effect.gen(function* () {
		const auth = yield* LanAuthService;
		const config = yield* LanAuthConfig;
		const relayConfig = yield* auth.getRelayConfig();
		const endpoint =
			relayConfig?.tunnelHostname !== undefined
				? EnvironmentEndpoint.make({
						httpBaseUrl: `https://${relayConfig.tunnelHostname}`,
						wsBaseUrl: `wss://${relayConfig.tunnelHostname}`,
					})
				: config.advertisedHost !== null && config.port !== null
					? EnvironmentEndpoint.make({
							httpBaseUrl: `http://${config.advertisedHost}:${config.port}`,
							wsBaseUrl: `ws://${config.advertisedHost}:${config.port}`,
						})
					: null;

		if (endpoint === null) {
			return yield* Effect.fail(
				new ConnectAuthError({ reason: "no_endpoint_configured" }),
			);
		}

		return EnvironmentDescriptor.make({
			environmentId: yield* auth.environmentId(),
			providerKind: "desktop",
			endpoint,
			label: yield* defaultEnvironmentLabel(),
			advertisedEndpoints: buildAdvertisedEndpoints({
				lan: config,
				relay:
					relayConfig === null
						? null
						: {
								linked: true,
								heartbeatActive: true,
								tunnelHostname: relayConfig.tunnelHostname,
							},
			}),
		});
	}).pipe(
		Effect.mapError((error) =>
			error instanceof ConnectAuthError
				? error
				: new ConnectAuthError({ reason: "describe_failed" }),
		),
	),
);

const ConnectLinkProof = MemoizeRpcs.toLayerHandler(
	"connect.linkProof",
	(input) =>
		Effect.gen(function* () {
			const auth = yield* LanAuthService;
			return yield* auth.linkProof(input);
		}).pipe(
			Effect.mapError(
				(error) =>
					new ConnectAuthError({
						reason:
							error instanceof Error ? error.message : "link_proof_failed",
					}),
			),
		),
);

const ConnectRelayConfig = MemoizeRpcs.toLayerHandler(
	"connect.relayConfig",
	(input) =>
		Effect.gen(function* () {
			const auth = yield* LanAuthService;
			yield* auth.saveRelayConfig(input);
		}).pipe(
			Effect.mapError(
				(error) =>
					new ConnectAuthError({
						reason:
							error instanceof Error ? error.message : "relay_config_failed",
					}),
			),
		),
);

export const LanAuthHandlersLayer = Layer.mergeAll(
	PairingStart,
	PairingListTokens,
	PairingRevokeToken,
	PairingListNearbyRequests,
	PairingResolveNearbyRequest,
	ConnectHandshake,
	ConnectDescribe,
	ConnectLinkProof,
	ConnectRelayConfig,
);
