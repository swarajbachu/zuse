import {
	CapabilityManifest,
	ConnectAuthError,
	EnvironmentDescriptor,
	MemoizeRpcs,
	NearbyPairingRequest,
	PairingError,
	PairingStartResult,
	WIRE_PROTOCOL_VERSION,
	WireProtocolRejected,
	WireWelcome,
} from "@zuse/contracts";
import { Effect, Layer } from "effect";

import {
	buildAdvertisedEndpoints,
	resolveDefaultEnvironmentEndpoint,
} from "./advertised-endpoints.ts";
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

export const makeEnvironmentCapabilities = (
	desktopHandoff: boolean,
): CapabilityManifest =>
	CapabilityManifest.make({
		version: 1,
		features: [
			"mobile-terminal-v1",
			"attachment-read-v1",
			"voice-account-transcription-v1",
			"git-remote-actions-v1",
			...(desktopHandoff ? (["desktop-handoff-v1"] as const) : []),
		],
	});

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
		const apiConfig = yield* auth.getApiConfig();
		const api =
			apiConfig === null
				? null
				: {
						linked: true,
						heartbeatActive: true,
						tunnelHostname: apiConfig.tunnelHostname,
					};
		const advertisedEndpoints = buildAdvertisedEndpoints({
			lan: config,
			api,
		});
		const endpoint = resolveDefaultEnvironmentEndpoint(advertisedEndpoints);

		if (endpoint === null) {
			return yield* Effect.fail(
				new ConnectAuthError({ reason: "no_endpoint_configured" }),
			);
		}

		return EnvironmentDescriptor.make({
			environmentId: yield* auth.environmentId(),
			providerKind: "desktop",
			endpoint,
			capabilities: makeEnvironmentCapabilities(
				config.openHostSession !== undefined,
			),
			label: yield* defaultEnvironmentLabel(),
			advertisedEndpoints,
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

const ConnectApiConfig = MemoizeRpcs.toLayerHandler(
	"connect.apiConfig",
	(input) =>
		Effect.gen(function* () {
			const auth = yield* LanAuthService;
			yield* auth.saveApiConfig(input);
		}).pipe(
			Effect.mapError(
				(error) =>
					new ConnectAuthError({
						reason:
							error instanceof Error ? error.message : "api_config_failed",
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
	ConnectApiConfig,
);
