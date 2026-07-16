import { Schema } from "effect";

import { EnvironmentEndpoint, ProviderKind } from "./connect.ts";
import { EnvironmentId } from "./ids.ts";

// ---------------------------------------------------------------------------
// Relay HTTP contract
// ---------------------------------------------------------------------------
//
// The relay is a thin control plane reached over HTTP (not the WS RPC surface):
// it links a WorkOS account to the environments it controls, brokers short-lived
// DPoP-bound connect tokens, and reports presence. It is never in the data path.
//
// These are the shared request/response shapes + path builders used by the
// desktop (self-registration) and mobile (discovery) clients, and mirrored by
// `@zuse/relay`. Auth is carried in headers, not bodies:
//   - WorkOS bearer:            `Authorization: Bearer <workos access token>`
//   - DPoP-bound access token:  `Authorization: DPoP <token>` + `DPoP: <proof>`
//   - environment credential:   `Authorization: Bearer zenv_…`

/** Paths, centralised so client + relay never drift. */
export const RelayPaths = {
	linkChallenges: "/v1/client/environment-link-challenges",
	links: "/v1/client/environment-links",
	/** Unlink (WorkOS bearer): deprovisions the managed tunnel + removes the env. */
	unlink: "/v1/client/environment-unlink",
	environments: "/v1/environments",
	dpopToken: "/v1/client/dpop-token",
	devices: "/v1/mobile/devices",
	account: "/v1/account",
	status: (environmentId: string) =>
		`/v1/environments/${encodeURIComponent(environmentId)}/status`,
	connect: (environmentId: string) =>
		`/v1/environments/${encodeURIComponent(environmentId)}/connect`,
	heartbeat: (environmentId: string) =>
		`/v1/environments/${encodeURIComponent(environmentId)}/heartbeat`,
	agentActivity: (environmentId: string) =>
		`/v1/environments/${encodeURIComponent(environmentId)}/agent-activity`,
} as const;

/** DPoP access-token scopes the relay recognises. */
export const RelayScope = Schema.Literals([
	"environment:status",
	"environment:connect",
	"mobile:registration",
]);
export type RelayScope = typeof RelayScope.Type;

// --- link challenge (desktop, WorkOS bearer) ---------------------------------

export class RelayLinkChallenge extends Schema.Class<RelayLinkChallenge>(
	"RelayLinkChallenge",
)({
	challengeId: Schema.String,
	challenge: Schema.String,
	relayIssuer: Schema.String,
	expiresAt: Schema.Number,
}) {}

// --- link (desktop, WorkOS bearer) -------------------------------------------
//
// The desktop signs an Ed25519 JWT over { challenge, environmentId } (aud =
// relayIssuer, typ = "environment-link-proof+jwt") and sends its public key so
// the relay can verify this and every later proof.

export class RelayLinkRequest extends Schema.Class<RelayLinkRequest>(
	"RelayLinkRequest",
)({
	challengeId: Schema.String,
	proof: Schema.String,
	environmentId: EnvironmentId,
	/** The environment's Ed25519 public key, as a JWK JSON string. */
	environmentPublicKey: Schema.String,
	providerKind: ProviderKind,
	endpoint: EnvironmentEndpoint,
	label: Schema.optional(Schema.String),
}) {}

export class RelayLinkResponse extends Schema.Class<RelayLinkResponse>(
	"RelayLinkResponse",
)({
	environmentId: EnvironmentId,
	endpoint: EnvironmentEndpoint,
	relayIssuer: Schema.String,
	/** Plaintext per-environment credential (`zenv_…`); the relay stores only its hash. */
	environmentCredential: Schema.String,
	/** Relay Ed25519 public key (JWK JSON) for verifying minted tokens. */
	mintPublicKey: Schema.String,
}) {}

// --- discovery (mobile/desktop, WorkOS bearer) -------------------------------

export class RelayEnvironmentRecord extends Schema.Class<RelayEnvironmentRecord>(
	"RelayEnvironmentRecord",
)({
	environmentId: EnvironmentId,
	label: Schema.optional(Schema.String),
	providerKind: ProviderKind,
	endpoint: Schema.optional(EnvironmentEndpoint),
	linkedAt: Schema.Number,
}) {}

export class RelayEnvironmentList extends Schema.Class<RelayEnvironmentList>(
	"RelayEnvironmentList",
)({
	environments: Schema.Array(RelayEnvironmentRecord),
}) {}

// --- dpop token exchange (WorkOS bearer + DPoP proof) ------------------------

export class RelayAccessToken extends Schema.Class<RelayAccessToken>(
	"RelayAccessToken",
)({
	accessToken: Schema.String,
	expiresIn: Schema.Number,
}) {}

// --- presence (mobile, DPoP) -------------------------------------------------

export const RelayPresence = Schema.Literals(["online", "offline"]);
export type RelayPresence = typeof RelayPresence.Type;

export class RelayEnvironmentStatus extends Schema.Class<RelayEnvironmentStatus>(
	"RelayEnvironmentStatus",
)({
	status: RelayPresence,
	endpoint: EnvironmentEndpoint,
	checkedAt: Schema.Number,
}) {}

// --- connect (mobile, DPoP) --------------------------------------------------

export class RelayConnectGrant extends Schema.Class<RelayConnectGrant>(
	"RelayConnectGrant",
)({
	endpoint: EnvironmentEndpoint,
	connectToken: Schema.String,
	expiresAt: Schema.Number,
}) {}

// --- device registration (mobile, DPoP) --------------------------------------

export class RelayDeviceRegistration extends Schema.Class<RelayDeviceRegistration>(
	"RelayDeviceRegistration",
)({
	deviceId: Schema.String,
	platform: Schema.Literals(["ios", "android", "web"]),
	pushToken: Schema.optional(Schema.String),
	dpopJwk: Schema.optional(Schema.Unknown),
}) {}
