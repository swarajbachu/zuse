import {
	ApiControlError,
	ApiLinkStatus,
	ConnectAuthError,
	MemoizeRpcs,
} from "@zuse/contracts";
import { Effect, Layer } from "effect";

import { ApiLinkService, type ApiLinkStatusValue } from "./api-link-service.ts";

const toStatus = (value: ApiLinkStatusValue): ApiLinkStatus =>
	ApiLinkStatus.make({
		linked: value.linked,
		apiUrl: value.apiUrl,
		environmentId: value.environmentId,
		label: value.label,
		heartbeatActive: value.heartbeatActive,
		advertisedEndpoints: value.advertisedEndpoints,
	});

const toConnectError = (reason: string): ConnectAuthError =>
	new ConnectAuthError({ reason });

const ApiLink = MemoizeRpcs.toLayerHandler("api.link", (input) =>
	Effect.gen(function* () {
		const service = yield* ApiLinkService;
		return toStatus(yield* service.link(input));
	}).pipe(Effect.mapError((error) => toConnectError(error.reason))),
);

const ApiStatus = MemoizeRpcs.toLayerHandler("api.status", () =>
	Effect.gen(function* () {
		const service = yield* ApiLinkService;
		return toStatus(yield* service.status());
	}).pipe(Effect.mapError((error) => toConnectError(error.reason))),
);

const ApiUnlink = MemoizeRpcs.toLayerHandler("api.unlink", () =>
	Effect.gen(function* () {
		const service = yield* ApiLinkService;
		yield* service.unlink();
	}).pipe(Effect.mapError((error) => toConnectError(error.reason))),
);

const toApiControlError = (reason: string): ApiControlError =>
	new ApiControlError({ reason });

const ApiEnvironments = MemoizeRpcs.toLayerHandler("api.environments", () =>
	Effect.gen(function* () {
		const service = yield* ApiLinkService;
		return yield* service.listEnvironments();
	}).pipe(Effect.mapError((error) => toApiControlError(error.reason))),
);

const ApiConnectEnvironment = MemoizeRpcs.toLayerHandler(
	"api.connectEnvironment",
	({ environmentId }) =>
		Effect.gen(function* () {
			const service = yield* ApiLinkService;
			return yield* service.connectEnvironment(environmentId);
		}).pipe(Effect.mapError((error) => toApiControlError(error.reason))),
);

const ApiClients = MemoizeRpcs.toLayerHandler("api.clients", () =>
	Effect.gen(function* () {
		const service = yield* ApiLinkService;
		return yield* service.listClients();
	}).pipe(Effect.mapError((error) => toApiControlError(error.reason))),
);

const ApiRevokeClient = MemoizeRpcs.toLayerHandler(
	"api.revokeClient",
	({ clientId }) =>
		Effect.gen(function* () {
			const service = yield* ApiLinkService;
			yield* service.revokeClient(clientId);
		}).pipe(Effect.mapError((error) => toApiControlError(error.reason))),
);

export const ApiHandlersLayer = Layer.mergeAll(
	ApiLink,
	ApiStatus,
	ApiUnlink,
	ApiEnvironments,
	ApiConnectEnvironment,
	ApiClients,
	ApiRevokeClient,
);
