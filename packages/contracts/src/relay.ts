import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import {
	CapabilityManifest,
	ConnectAuthError,
	EnvironmentEndpoint,
	EnvironmentEndpointHealth,
	EnvironmentServiceState,
	ProviderKind,
} from "./connect.ts";
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
	authToken: "/v1/auth/token",
	linkChallenges: "/v1/client/environment-link-challenges",
	links: "/v1/client/environment-links",
	/** Unlink (WorkOS bearer): deprovisions the managed tunnel + removes the env. */
	unlink: "/v1/client/environment-unlink",
	environments: "/v1/environments",
	dpopToken: "/v1/client/dpop-token",
	devices: "/v1/mobile/devices",
	clients: "/v1/clients",
	client: (clientId: string) => `/v1/clients/${encodeURIComponent(clientId)}`,
	account: "/v1/account",
	status: (environmentId: string) =>
		`/v1/environments/${encodeURIComponent(environmentId)}/status`,
	connect: (environmentId: string) =>
		`/v1/environments/${encodeURIComponent(environmentId)}/connect`,
	heartbeat: (environmentId: string) =>
		`/v1/environments/${encodeURIComponent(environmentId)}/heartbeat`,
	agentActivity: (environmentId: string) =>
		`/v1/environments/${encodeURIComponent(environmentId)}/agent-activity`,
	machineOffers: "/v1/machine-offers",
	machines: "/v1/machines",
	machine: (machineId: string) =>
		`/v1/machines/${encodeURIComponent(machineId)}`,
	machineCancel: (machineId: string) =>
		`/v1/machines/${encodeURIComponent(machineId)}/cancel`,
	machineRecover: (machineId: string) =>
		`/v1/machines/${encodeURIComponent(machineId)}/recover`,
	machineDestroy: (machineId: string) =>
		`/v1/machines/${encodeURIComponent(machineId)}/destroy`,
	machineEnroll: "/v1/machines/enroll",
	machineBootStatus: (machineId: string) =>
		`/v1/machines/${encodeURIComponent(machineId)}/boot-status`,
	billingCheckout: "/v1/billing/checkout",
	billingCheckoutComplete: "/v1/billing/checkout/complete",
	billingEntitlements: "/v1/billing/entitlements",
	billingPortal: "/v1/billing/portal",
	billingWebhook: "/v1/billing/webhook",
	billingProviderWebhook: (providerId: string) =>
		`/v1/billing/webhook/${encodeURIComponent(providerId)}`,
	cloudProviders: "/v1/cloud/providers",
	cloudProjects: "/v1/cloud/projects",
	cloudProjectPrepare: (projectId: string) =>
		`/v1/cloud/projects/${encodeURIComponent(projectId)}/prepare`,
	cloudWorkspaces: "/v1/cloud/workspaces",
	cloudWorkspace: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}`,
	cloudWorkspaceConnectionGrant: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/connection-grant`,
	cloudWorkspaceGateway: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/gateway`,
	cloudWorkspaceBootstrap: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/runtime/bootstrap`,
	cloudWorkspaceCommands: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/runtime/commands`,
	cloudWorkspaceEvents: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/runtime/events`,
	cloudWorkspaceActivity: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/runtime/activity`,
	cloudWorkspaceHistory: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/chat`,
	cloudWorkspaceMessages: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/messages`,
	cloudChats: "/v1/cloud/chats",
	cloudWorkspaceAction: (workspaceId: string, action: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/${encodeURIComponent(action)}`,
	cloudWorkspaceReady: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/ready`,
	cloudCredentials: "/v1/cloud/credentials",
	cloudCredentialDisconnect: (kind: string) =>
		`/v1/cloud/credentials/${encodeURIComponent(kind)}/disconnect`,
} as const;

export const RelayAuthTokenGrant = Schema.Union([
	Schema.Struct({
		grantType: Schema.Literal("authorization_code"),
		code: Schema.String,
		codeVerifier: Schema.String,
	}),
	Schema.Struct({
		grantType: Schema.Literal("refresh_token"),
		refreshToken: Schema.String,
	}),
]);
export type RelayAuthTokenGrant = typeof RelayAuthTokenGrant.Type;

export const RelayAuthTokenResponse = Schema.Struct({
	access_token: Schema.String,
	refresh_token: Schema.String,
});
export type RelayAuthTokenResponse = typeof RelayAuthTokenResponse.Type;

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
	runtimeVersion: Schema.optional(Schema.String),
	wireProtocolVersion: Schema.optional(Schema.Number),
	capabilities: Schema.optional(CapabilityManifest),
	serviceState: Schema.optional(EnvironmentServiceState),
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
	runtimeVersion: Schema.optional(Schema.String),
	wireProtocolVersion: Schema.optional(Schema.Number),
	capabilities: Schema.optional(CapabilityManifest),
	serviceState: Schema.optional(EnvironmentServiceState),
	endpointHealth: Schema.optional(EnvironmentEndpointHealth),
	lastHeartbeat: Schema.optional(Schema.Number),
	/** Public environment identity used to verify environment-authored handoffs. */
	environmentPublicKey: Schema.optional(Schema.String),
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
	endpointCandidates: Schema.optional(
		Schema.Array(
			Schema.Struct({
				kind: Schema.Literals(["private-network", "managed-tunnel"]),
				endpoint: EnvironmentEndpoint,
			}),
		),
	),
	checkedAt: Schema.Number,
}) {}

// --- connect (mobile, DPoP) --------------------------------------------------

export class RelayConnectGrant extends Schema.Class<RelayConnectGrant>(
	"RelayConnectGrant",
)({
	endpoint: EnvironmentEndpoint,
	endpointCandidates: Schema.optional(
		Schema.Array(
			Schema.Struct({
				kind: Schema.Literals(["private-network", "managed-tunnel"]),
				endpoint: EnvironmentEndpoint,
			}),
		),
	),
	connectToken: Schema.String,
	expiresAt: Schema.Number,
}) {}

export class RelayLocalPairingBinding extends Schema.Class<RelayLocalPairingBinding>(
	"RelayLocalPairingBinding",
)({
	serverNonce: Schema.String,
	devicePublicKey: Schema.String,
	transportCertificatePin: Schema.String,
}) {}

export const EnvironmentsListRpc = Rpc.make("environments.list", {
	payload: Schema.Void,
	success: RelayEnvironmentList,
	error: ConnectAuthError,
});

export const EnvironmentConnectRpc = Rpc.make("environments.connect", {
	payload: Schema.Struct({ environmentId: EnvironmentId }),
	success: RelayConnectGrant,
	error: ConnectAuthError,
});

// --- device registration (mobile, DPoP) --------------------------------------

export class RelayDeviceRegistration extends Schema.Class<RelayDeviceRegistration>(
	"RelayDeviceRegistration",
)({
	deviceId: Schema.String,
	platform: Schema.Literals(["ios", "android", "web", "desktop"]),
	pushToken: Schema.optional(Schema.String),
	dpopJwk: Schema.optional(Schema.Unknown),
}) {}

export class RelayAuthorizedClient extends Schema.Class<RelayAuthorizedClient>(
	"RelayAuthorizedClient",
)({
	clientId: Schema.String,
	platform: Schema.Literals(["ios", "android", "web", "desktop"]),
	label: Schema.optional(Schema.String),
	lastSeenAt: Schema.Number,
}) {}

export class RelayAuthorizedClientList extends Schema.Class<RelayAuthorizedClientList>(
	"RelayAuthorizedClientList",
)({
	clients: Schema.Array(RelayAuthorizedClient),
}) {}

export class RelayControlError extends Schema.TaggedErrorClass<RelayControlError>()(
	"RelayControlError",
	{ reason: Schema.String },
) {}

export const RelayEnvironmentsRpc = Rpc.make("relay.environments", {
	payload: Schema.Void,
	success: RelayEnvironmentList,
	error: RelayControlError,
});

export const RelayConnectEnvironmentRpc = Rpc.make("relay.connectEnvironment", {
	payload: Schema.Struct({ environmentId: EnvironmentId }),
	success: RelayConnectGrant,
	error: RelayControlError,
});

export const RelayClientsRpc = Rpc.make("relay.clients", {
	payload: Schema.Void,
	success: RelayAuthorizedClientList,
	error: RelayControlError,
});

export const RelayRevokeClientRpc = Rpc.make("relay.revokeClient", {
	payload: Schema.Struct({ clientId: Schema.String }),
	success: Schema.Void,
	error: RelayControlError,
});
