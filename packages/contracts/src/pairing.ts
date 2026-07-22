import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

import { AuthTokenId } from "./ids.ts";

export class PairingStartResult extends Schema.Class<PairingStartResult>(
	"PairingStartResult",
)({
	pairingUrl: Schema.String,
	browserUrl: Schema.String,
	code: Schema.String,
	qrText: Schema.String,
	expiresAt: Schema.DateFromString,
}) {}

export class AuthTokenSummary extends Schema.Class<AuthTokenSummary>(
	"AuthTokenSummary",
)({
	id: AuthTokenId,
	deviceId: Schema.optional(Schema.String),
	label: Schema.optional(Schema.String),
	createdAt: Schema.DateFromString,
	lastUsedAt: Schema.optional(Schema.DateFromString),
	revokedAt: Schema.optional(Schema.DateFromString),
}) {}

export class PairingError extends Schema.TaggedErrorClass<PairingError>()(
	"PairingError",
	{ reason: Schema.String },
) {}

export class NearbyPairingRequest extends Schema.Class<NearbyPairingRequest>(
	"NearbyPairingRequest",
)({
	requestId: Schema.String,
	deviceId: Schema.String,
	deviceLabel: Schema.String,
	deviceModel: Schema.optional(Schema.String),
	deviceIdentifier: Schema.String,
	devicePublicKey: Schema.String,
	ephemeralPublicKey: Schema.String,
	clientNonce: Schema.String,
	serverNonce: Schema.String,
	safetyPhrase: Schema.String,
	createdAt: Schema.DateFromString,
	expiresAt: Schema.DateFromString,
}) {}

export const PairingStartRpc = Rpc.make("pairing.start", {
	payload: Schema.Struct({}),
	success: PairingStartResult,
	error: PairingError,
});

export const PairingListTokensRpc = Rpc.make("pairing.listTokens", {
	payload: Schema.Struct({}),
	success: Schema.Array(AuthTokenSummary),
	error: PairingError,
});

export const PairingRevokeTokenRpc = Rpc.make("pairing.revokeToken", {
	payload: Schema.Struct({ tokenId: AuthTokenId }),
	success: Schema.Void,
	error: PairingError,
});

export const PairingListNearbyRequestsRpc = Rpc.make(
	"pairing.listNearbyRequests",
	{
		payload: Schema.Struct({}),
		success: Schema.Array(NearbyPairingRequest),
		error: PairingError,
	},
);

export const PairingResolveNearbyRequestRpc = Rpc.make(
	"pairing.resolveNearbyRequest",
	{
		payload: Schema.Struct({
			requestId: Schema.String,
			decision: Schema.Literals(["allow", "deny", "block"]),
		}),
		success: Schema.Literals(["approved", "denied"]),
		error: PairingError,
	},
);
