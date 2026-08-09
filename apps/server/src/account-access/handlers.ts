import { AccountAccessOpError, MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer, Stream } from "effect";

import {
	AccountAccessService,
	type AccountAccessServiceShape,
} from "./service.ts";

const mapError = (error: { readonly code: string }): AccountAccessOpError =>
	new AccountAccessOpError({
		code: error.code as AccountAccessOpError["code"],
	});

const withService = <A>(
	run: (
		service: AccountAccessServiceShape,
	) => Effect.Effect<A, { readonly code: string }>,
) => Effect.flatMap(AccountAccessService, run).pipe(Effect.mapError(mapError));

const withStream = <A>(
	run: (
		service: AccountAccessServiceShape,
	) => Stream.Stream<A, { readonly code: string }>,
) =>
	Stream.unwrap(Effect.map(AccountAccessService, run)).pipe(
		Stream.mapError(mapError),
	);

const Status = MemoizeRpcs.toLayerHandler("accountAccess.status", () =>
	withService((service) => service.status()),
);

const DetectLocal = MemoizeRpcs.toLayerHandler(
	"accountAccess.detectLocal",
	() => withService((service) => service.detectLocal()),
);

const StartLogin = MemoizeRpcs.toLayerHandler(
	"accountAccess.startLogin",
	({ providerId }) => withStream((service) => service.startLogin(providerId)),
);

const PrepareImport = MemoizeRpcs.toLayerHandler(
	"accountAccess.prepareImport",
	(input) => withService((service) => service.prepareImport(input)),
);

const CreateClaudeTransfer = MemoizeRpcs.toLayerHandler(
	"accountAccess.createClaudeTransfer",
	(input) => withStream((service) => service.createClaudeTransfer(input)),
);

const ContinueClaudeTransfer = MemoizeRpcs.toLayerHandler(
	"accountAccess.continueClaudeTransfer",
	(input) => withService((service) => service.continueClaudeTransfer(input)),
);

const ImportCredential = MemoizeRpcs.toLayerHandler(
	"accountAccess.import",
	(input) => withService((service) => service.importCredential(input)),
);

const Disconnect = MemoizeRpcs.toLayerHandler(
	"accountAccess.disconnect",
	({ providerId }) => withService((service) => service.disconnect(providerId)),
);

export const AccountAccessHandlersLayer = Layer.mergeAll(
	Status,
	DetectLocal,
	StartLogin,
	PrepareImport,
	CreateClaudeTransfer,
	ContinueClaudeTransfer,
	ImportCredential,
	Disconnect,
);
