import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { CloudWorkspaceOpError } from "./cloud-workspaces.ts";

// ---------------------------------------------------------------------------
// Cloud Workspaces public API contract
// ---------------------------------------------------------------------------
//
// The public API is the API's machine-caller surface (`/v1/api/**`) used by
// external integrations (Slack bots, scripts, CI). Auth is an account-scoped
// API key carried as `Authorization: Bearer zk_…`; keys are managed over the
// WorkOS-gated `/v1/cloud/api-keys` routes and the `cloud.apiKeys.*` RPCs.
// Replies flow back through the per-workspace conversation ledger (polling)
// and signed `workspace.turn.completed` webhooks.

export class CloudApiKey extends Schema.Class<CloudApiKey>("CloudApiKey")({
	keyId: Schema.String,
	name: Schema.String,
	/** First characters of the secret, for display only. */
	prefix: Schema.String,
	createdAt: Schema.Number,
	lastUsedAt: Schema.NullOr(Schema.Number),
	revokedAt: Schema.NullOr(Schema.Number),
}) {}

export class CloudApiKeyList extends Schema.Class<CloudApiKeyList>(
	"CloudApiKeyList",
)({ keys: Schema.Array(CloudApiKey) }) {}

export class CloudApiKeyCreateRequest extends Schema.Class<CloudApiKeyCreateRequest>(
	"CloudApiKeyCreateRequest",
)({ name: Schema.String }) {}

export class CloudApiKeyCreated extends Schema.Class<CloudApiKeyCreated>(
	"CloudApiKeyCreated",
)({
	key: CloudApiKey,
	/** The full `zk_…` secret. Shown exactly once; only a hash is stored. */
	secret: Schema.String,
}) {}

export class CloudApiKeyRevokeRequest extends Schema.Class<CloudApiKeyRevokeRequest>(
	"CloudApiKeyRevokeRequest",
)({ keyId: Schema.String }) {}

export const CloudApiKeysListRpc = Rpc.make("cloud.apiKeys.list", {
	payload: Schema.Void,
	success: CloudApiKeyList,
	error: CloudWorkspaceOpError,
});
export const CloudApiKeysCreateRpc = Rpc.make("cloud.apiKeys.create", {
	payload: CloudApiKeyCreateRequest,
	success: CloudApiKeyCreated,
	error: CloudWorkspaceOpError,
});
export const CloudApiKeysRevokeRpc = Rpc.make("cloud.apiKeys.revoke", {
	payload: CloudApiKeyRevokeRequest,
	success: CloudApiKey,
	error: CloudWorkspaceOpError,
});

// ---------------------------------------------------------------------------
// `/v1/api/**` request/response shapes
// ---------------------------------------------------------------------------

export const ApiAgentStatus = Schema.Literals(["working", "idle", "unknown"]);

export class ApiWorkspaceLastTurn extends Schema.Class<ApiWorkspaceLastTurn>(
	"ApiWorkspaceLastTurn",
)({
	turnId: Schema.String,
	outcome: Schema.String,
	completedAt: Schema.Number,
}) {}

export class ApiWorkspaceStatus extends Schema.Class<ApiWorkspaceStatus>(
	"ApiWorkspaceStatus",
)({
	workspaceId: Schema.String,
	projectId: Schema.String,
	branch: Schema.String,
	baseRef: Schema.String,
	state: Schema.String,
	statusCode: Schema.String,
	startupPhase: Schema.String,
	runtimeState: Schema.String,
	agentStatus: ApiAgentStatus,
	/** Highest conversation-ledger sequence; poll messages with `afterSeq`. */
	latestSeq: Schema.Number,
	lastTurn: Schema.NullOr(ApiWorkspaceLastTurn),
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
}) {}

export class ApiWorkspaceList extends Schema.Class<ApiWorkspaceList>(
	"ApiWorkspaceList",
)({ workspaces: Schema.Array(ApiWorkspaceStatus) }) {}

export class ApiProject extends Schema.Class<ApiProject>("ApiProject")({
	projectId: Schema.String,
	repository: Schema.String,
	displayName: Schema.String,
	defaultBranch: Schema.String,
	state: Schema.String,
}) {}

export class ApiProjectList extends Schema.Class<ApiProjectList>(
	"ApiProjectList",
)({ projects: Schema.Array(ApiProject) }) {}

export class ApiWorkspaceCreateRequest extends Schema.Class<ApiWorkspaceCreateRequest>(
	"ApiWorkspaceCreateRequest",
)({
	prompt: Schema.String,
	/** Defaults to the account's only ready project when unambiguous. */
	projectId: Schema.optional(Schema.String),
	providerId: Schema.optional(Schema.String),
	agent: Schema.optional(Schema.String),
	model: Schema.optional(Schema.String),
	baseRef: Schema.optional(Schema.String),
	branch: Schema.optional(Schema.String),
	/** Falls back to the `Idempotency-Key` header. */
	idempotencyKey: Schema.optional(Schema.String),
}) {}

export class ApiSendMessageRequest extends Schema.Class<ApiSendMessageRequest>(
	"ApiSendMessageRequest",
)({
	text: Schema.String,
	/** Falls back to the `Idempotency-Key` header. */
	idempotencyKey: Schema.optional(Schema.String),
}) {}

export class ApiSendMessageReceipt extends Schema.Class<ApiSendMessageReceipt>(
	"ApiSendMessageReceipt",
)({
	messageId: Schema.String,
	seq: Schema.Number,
	status: Schema.Literals(["queued", "delivered"]),
	resumeTriggered: Schema.Boolean,
}) {}

export class ApiMessage extends Schema.Class<ApiMessage>("ApiMessage")({
	messageId: Schema.String,
	seq: Schema.Number,
	role: Schema.Literals(["user", "assistant"]),
	text: Schema.String,
	status: Schema.Literals([
		"pending",
		"delivered",
		"settled",
		"failed",
		"expired",
	]),
	turnId: Schema.optional(Schema.String),
	outcome: Schema.optional(Schema.String),
	createdAt: Schema.Number,
}) {}

export class ApiMessageList extends Schema.Class<ApiMessageList>(
	"ApiMessageList",
)({
	messages: Schema.Array(ApiMessage),
	latestSeq: Schema.Number,
}) {}

export class ApiWebhookCreateRequest extends Schema.Class<ApiWebhookCreateRequest>(
	"ApiWebhookCreateRequest",
)({
	url: Schema.String,
	description: Schema.optional(Schema.String),
}) {}

export class ApiWebhookEndpoint extends Schema.Class<ApiWebhookEndpoint>(
	"ApiWebhookEndpoint",
)({
	webhookId: Schema.String,
	url: Schema.String,
	description: Schema.optional(Schema.String),
	createdAt: Schema.Number,
}) {}

export class ApiWebhookCreated extends Schema.Class<ApiWebhookCreated>(
	"ApiWebhookCreated",
)({
	webhook: ApiWebhookEndpoint,
	/** The `whsec_…` signing secret. Shown exactly once. */
	secret: Schema.String,
}) {}

export class ApiWebhookList extends Schema.Class<ApiWebhookList>(
	"ApiWebhookList",
)({ webhooks: Schema.Array(ApiWebhookEndpoint) }) {}

/**
 * Body of a `workspace.turn.completed` webhook delivery. Deliveries carry
 * `zuse-event-id` and `zuse-signature: t=<unixSeconds>,v1=<hex hmac-sha256>`
 * headers; the signature covers `<t>.<rawBody>` with the endpoint secret.
 */
export class ApiWebhookTurnCompletedEvent extends Schema.Class<ApiWebhookTurnCompletedEvent>(
	"ApiWebhookTurnCompletedEvent",
)({
	eventId: Schema.String,
	type: Schema.Literal("workspace.turn.completed"),
	createdAt: Schema.Number,
	workspaceId: Schema.String,
	branch: Schema.String,
	turnId: Schema.String,
	outcome: Schema.String,
	reply: Schema.Struct({
		text: Schema.String,
		truncated: Schema.Boolean,
	}),
	messageSeq: Schema.Number,
}) {}

// ---------------------------------------------------------------------------
// Runtime command-pump shapes (API ⇄ in-sandbox runtime)
// ---------------------------------------------------------------------------

export class CloudRuntimeCommand extends Schema.Class<CloudRuntimeCommand>(
	"CloudRuntimeCommand",
)({
	messageId: Schema.String,
	/** Domain command id (`api:<messageId>`) so redelivery stays idempotent. */
	commandId: Schema.String,
	sessionId: Schema.String,
	text: Schema.String,
	seq: Schema.Number,
}) {}

export class CloudRuntimeCommandList extends Schema.Class<CloudRuntimeCommandList>(
	"CloudRuntimeCommandList",
)({ commands: Schema.Array(CloudRuntimeCommand) }) {}

export class CloudRuntimeCommandAck extends Schema.Class<CloudRuntimeCommandAck>(
	"CloudRuntimeCommandAck",
)({ messageId: Schema.String }) {}

/** Bounded excerpt cap for turn-event reply text (UTF-16 code units). */
export const CLOUD_RUNTIME_TURN_REPLY_MAX_LENGTH = 16_384;

export class CloudRuntimeTurnEventUpload extends Schema.Class<CloudRuntimeTurnEventUpload>(
	"CloudRuntimeTurnEventUpload",
)({
	sessionId: Schema.String,
	turnId: Schema.String,
	outcome: Schema.String,
	settledAt: Schema.Number,
	replyText: Schema.String,
	replyTruncated: Schema.Boolean,
}) {}
