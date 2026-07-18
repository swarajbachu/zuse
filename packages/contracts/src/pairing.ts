import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

import { AuthTokenId } from "./ids.ts";

export class PairingStartResult extends Schema.Class<PairingStartResult>(
	"PairingStartResult",
)({
	pairingUrl: Schema.String,
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
