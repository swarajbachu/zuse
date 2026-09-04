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
// API HTTP contract
// ---------------------------------------------------------------------------
//
// The api is a thin control plane reached over HTTP (not the WS RPC surface):
// it links a WorkOS account to the environments it controls, brokers short-lived
// DPoP-bound connect tokens, and reports presence. It is never in the data path.
//
// These are the shared request/response shapes + path builders used by the
// desktop (self-registration) and mobile (discovery) clients, and mirrored by
// `@zuse/api`. Auth is carried in headers, not bodies:
//   - WorkOS bearer:            `Authorization: Bearer <workos access token>`
//   - DPoP-bound access token:  `Authorization: DPoP <token>` + `DPoP: <proof>`
//   - environment credential:   `Authorization: Bearer zenv_…`

/** Paths, centralised so client + api never drift. */
export const ApiPaths = {
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
	cloudBillingSummary: "/v1/cloud/billing/summary",
	cloudBillingUsage: "/v1/cloud/billing/usage",
	cloudBillingCap: "/v1/cloud/billing/cap",
	cloudProviders: "/v1/cloud/providers",
	cloudAuth: "/v1/cloud/auth",
	cloudAuthProvision: "/v1/cloud/auth/provision",
	cloudAuthConfigure: "/v1/cloud/auth/configure",
	cloudAuthLoginStart: "/v1/cloud/auth/login/start",
	cloudAuthLoginPoll: (operationId: string) =>
		`/v1/cloud/auth/login/${encodeURIComponent(operationId)}`,
	cloudAuthLoginCancel: (operationId: string) =>
		`/v1/cloud/auth/login/${encodeURIComponent(operationId)}/cancel`,
	cloudAuthDisconnect: (providerId: string) =>
		`/v1/cloud/auth/providers/${encodeURIComponent(providerId)}`,
	cloudGithub: "/v1/cloud/github",
	cloudGithubInstall: "/v1/cloud/github/install",
	cloudGithubCallback: "/v1/cloud/github/callback",
	cloudGithubDisconnect: (installationId: number) =>
		`/v1/cloud/github/installations/${installationId}`,
	cloudProjects: "/v1/cloud/projects",
	cloudProject: (projectId: string) =>
		`/v1/cloud/projects/${encodeURIComponent(projectId)}`,
	cloudAccountImage: "/v1/cloud/image",
	cloudAccountImageBuild: "/v1/cloud/image/build",
	cloudProjectPrepare: (projectId: string) =>
		`/v1/cloud/projects/${encodeURIComponent(projectId)}/prepare`,
	cloudWorkspaces: "/v1/cloud/workspaces",
	cloudWorkspace: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}`,
	cloudWorkspaceConnectionTicket: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/gateway/ticket`,
	cloudWorkspaceSshAccess: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/ssh-access`,
	cloudWorkspacePreviewUrl: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/preview-url`,
	cloudWorkspaceGateway: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/gateway`,
	cloudWorkspaceCommands: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/commands`,
	cloudWorkspaceDataKey: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/data-key`,
	cloudWorkspaceCommand: (workspaceId: string, commandId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/commands/${encodeURIComponent(commandId)}`,
	cloudWorkspaceCommandWatch: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/commands/watch`,
	cloudWorkspaceRuntimeCommandLease: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/runtime/commands/lease`,
	cloudWorkspaceRuntimeCommandAck: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/runtime/commands/ack`,
	cloudWorkspaceBootstrap: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/runtime/bootstrap`,
	cloudWorkspaceBootstrapAck: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/runtime/bootstrap/ack`,
	cloudWorkspaceRuntimeCredentialsRenew: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/runtime/credentials/renew`,
	cloudWorkspaceRuntimeGithubCredential: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/runtime/github-credential`,
	cloudWorkspaceRuntimeCodexGrant: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/runtime/providers/codex/grant`,
	cloudWorkspaceRuntimeProviderGrant: (
		workspaceId: string,
		providerId: string,
	) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/runtime/providers/${encodeURIComponent(providerId)}/grant`,
	cloudWorkspaceActivity: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/runtime/activity`,
	cloudWorkspaceSummary: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/runtime/summary`,
	cloudWorkspaceRuntimeTranscriptCheckpoint: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/runtime/transcript-checkpoint`,
	cloudWorkspaceRuntimeTranscriptMessagePage: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/runtime/transcript-message-page`,
	cloudWorkspaceTranscriptCheckpoint: (
		workspaceId: string,
		sessionId: string,
	) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/transcript-checkpoint`,
	cloudWorkspaceTranscriptMessagePage: (
		workspaceId: string,
		sessionId: string,
	) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/transcript-message-page`,
	cloudChats: "/v1/cloud/chats",
	cloudWorkspaceAction: (workspaceId: string, action: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/${encodeURIComponent(action)}`,
	cloudWorkspaceReady: (workspaceId: string) =>
		`/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/ready`,
} as const;

export const ApiAuthTokenGrant = Schema.Union([
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
export type ApiAuthTokenGrant = typeof ApiAuthTokenGrant.Type;

export const ApiAuthTokenResponse = Schema.Struct({
	access_token: Schema.String,
	refresh_token: Schema.String,
});
export type ApiAuthTokenResponse = typeof ApiAuthTokenResponse.Type;

/** DPoP access-token scopes the api recognises. */
export const ApiScope = Schema.Literals([
	"environment:status",
	"environment:connect",
	"mobile:registration",
]);
export type ApiScope = typeof ApiScope.Type;

// --- link challenge (desktop, WorkOS bearer) ---------------------------------

export class ApiLinkChallenge extends Schema.Class<ApiLinkChallenge>(
	"ApiLinkChallenge",
)({
	challengeId: Schema.String,
	challenge: Schema.String,
	apiIssuer: Schema.String,
	expiresAt: Schema.Number,
}) {}

// --- link (desktop, WorkOS bearer) -------------------------------------------
//
// The desktop signs an Ed25519 JWT over { challenge, environmentId } (aud =
// apiIssuer, typ = "environment-link-proof+jwt") and sends its public key so
// the api can verify this and every later proof.

export class ApiLinkRequest extends Schema.Class<ApiLinkRequest>(
	"ApiLinkRequest",
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

export class ApiLinkResponse extends Schema.Class<ApiLinkResponse>(
	"ApiLinkResponse",
)({
	environmentId: EnvironmentId,
	endpoint: EnvironmentEndpoint,
	apiIssuer: Schema.String,
	/** Plaintext per-environment credential (`zenv_…`); the api stores only its hash. */
	environmentCredential: Schema.String,
	/** API Ed25519 public key (JWK JSON) for verifying minted tokens. */
	mintPublicKey: Schema.String,
}) {}

// --- discovery (mobile/desktop, WorkOS bearer) -------------------------------

export class ApiEnvironmentRecord extends Schema.Class<ApiEnvironmentRecord>(
	"ApiEnvironmentRecord",
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

export class ApiEnvironmentList extends Schema.Class<ApiEnvironmentList>(
	"ApiEnvironmentList",
)({
	environments: Schema.Array(ApiEnvironmentRecord),
}) {}

// --- dpop token exchange (WorkOS bearer + DPoP proof) ------------------------

export class ApiAccessToken extends Schema.Class<ApiAccessToken>(
	"ApiAccessToken",
)({
	accessToken: Schema.String,
	expiresIn: Schema.Number,
}) {}

// --- presence (mobile, DPoP) -------------------------------------------------

export const ApiPresence = Schema.Literals(["online", "offline"]);
export type ApiPresence = typeof ApiPresence.Type;

export class ApiEnvironmentStatus extends Schema.Class<ApiEnvironmentStatus>(
	"ApiEnvironmentStatus",
)({
	status: ApiPresence,
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

export class ApiConnectGrant extends Schema.Class<ApiConnectGrant>(
	"ApiConnectGrant",
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

export class ApiLocalPairingBinding extends Schema.Class<ApiLocalPairingBinding>(
	"ApiLocalPairingBinding",
)({
	serverNonce: Schema.String,
	devicePublicKey: Schema.String,
	transportCertificatePin: Schema.String,
}) {}

export const EnvironmentsListRpc = Rpc.make("environments.list", {
	payload: Schema.Void,
	success: ApiEnvironmentList,
	error: ConnectAuthError,
});

export const EnvironmentConnectRpc = Rpc.make("environments.connect", {
	payload: Schema.Struct({ environmentId: EnvironmentId }),
	success: ApiConnectGrant,
	error: ConnectAuthError,
});

// --- device registration (mobile, DPoP) --------------------------------------

export class ApiDeviceRegistration extends Schema.Class<ApiDeviceRegistration>(
	"ApiDeviceRegistration",
)({
	deviceId: Schema.String,
	platform: Schema.Literals(["ios", "android", "web", "desktop"]),
	pushToken: Schema.optional(Schema.String),
	dpopJwk: Schema.optional(Schema.Unknown),
}) {}

export class ApiAuthorizedClient extends Schema.Class<ApiAuthorizedClient>(
	"ApiAuthorizedClient",
)({
	clientId: Schema.String,
	platform: Schema.Literals(["ios", "android", "web", "desktop"]),
	label: Schema.optional(Schema.String),
	lastSeenAt: Schema.Number,
}) {}

export class ApiAuthorizedClientList extends Schema.Class<ApiAuthorizedClientList>(
	"ApiAuthorizedClientList",
)({
	clients: Schema.Array(ApiAuthorizedClient),
}) {}

export class ApiControlError extends Schema.TaggedErrorClass<ApiControlError>()(
	"ApiControlError",
	{ reason: Schema.String },
) {}

export const ApiEnvironmentsRpc = Rpc.make("api.environments", {
	payload: Schema.Void,
	success: ApiEnvironmentList,
	error: ApiControlError,
});

export const ApiConnectEnvironmentRpc = Rpc.make("api.connectEnvironment", {
	payload: Schema.Struct({ environmentId: EnvironmentId }),
	success: ApiConnectGrant,
	error: ApiControlError,
});

export const ApiClientsRpc = Rpc.make("api.clients", {
	payload: Schema.Void,
	success: ApiAuthorizedClientList,
	error: ApiControlError,
});

export const ApiRevokeClientRpc = Rpc.make("api.revokeClient", {
	payload: Schema.Struct({ clientId: Schema.String }),
	success: Schema.Void,
	error: ApiControlError,
});
