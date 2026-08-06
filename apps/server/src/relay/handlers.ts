import {
	ConnectAuthError,
	MemoizeRpcs,
	RelayControlError,
	RelayLinkStatus,
} from "@zuse/contracts";
import { Effect, Layer } from "effect";

import {
	RelayLinkService,
	type RelayLinkStatusValue,
} from "./relay-link-service.ts";

const toStatus = (value: RelayLinkStatusValue): RelayLinkStatus =>
	RelayLinkStatus.make({
		linked: value.linked,
		relayUrl: value.relayUrl,
		environmentId: value.environmentId,
		label: value.label,
		heartbeatActive: value.heartbeatActive,
		advertisedEndpoints: value.advertisedEndpoints,
	});

const toConnectError = (reason: string): ConnectAuthError =>
	new ConnectAuthError({ reason });

const RelayLink = MemoizeRpcs.toLayerHandler("relay.link", (input) =>
	Effect.gen(function* () {
		const service = yield* RelayLinkService;
		return toStatus(yield* service.link(input));
	}).pipe(Effect.mapError((error) => toConnectError(error.reason))),
);

const RelayStatus = MemoizeRpcs.toLayerHandler("relay.status", () =>
	Effect.gen(function* () {
		const service = yield* RelayLinkService;
		return toStatus(yield* service.status());
	}).pipe(Effect.mapError((error) => toConnectError(error.reason))),
);

const RelayUnlink = MemoizeRpcs.toLayerHandler("relay.unlink", () =>
	Effect.gen(function* () {
		const service = yield* RelayLinkService;
		yield* service.unlink();
	}).pipe(Effect.mapError((error) => toConnectError(error.reason))),
);

const toRelayControlError = (reason: string): RelayControlError =>
	new RelayControlError({ reason });

const RelayEnvironments = MemoizeRpcs.toLayerHandler("relay.environments", () =>
	Effect.gen(function* () {
		const service = yield* RelayLinkService;
		return yield* service.listEnvironments();
	}).pipe(Effect.mapError((error) => toRelayControlError(error.reason))),
);

const RelayConnectEnvironment = MemoizeRpcs.toLayerHandler(
	"relay.connectEnvironment",
	({ environmentId }) =>
		Effect.gen(function* () {
			const service = yield* RelayLinkService;
			return yield* service.connectEnvironment(environmentId);
		}).pipe(Effect.mapError((error) => toRelayControlError(error.reason))),
);

const RelayClients = MemoizeRpcs.toLayerHandler("relay.clients", () =>
	Effect.gen(function* () {
		const service = yield* RelayLinkService;
		return yield* service.listClients();
	}).pipe(Effect.mapError((error) => toRelayControlError(error.reason))),
);

const RelayRevokeClient = MemoizeRpcs.toLayerHandler(
	"relay.revokeClient",
	({ clientId }) =>
		Effect.gen(function* () {
			const service = yield* RelayLinkService;
			yield* service.revokeClient(clientId);
		}).pipe(Effect.mapError((error) => toRelayControlError(error.reason))),
);

export const RelayHandlersLayer = Layer.mergeAll(
	RelayLink,
	RelayStatus,
	RelayUnlink,
	RelayEnvironments,
	RelayConnectEnvironment,
	RelayClients,
	RelayRevokeClient,
);
