import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { CloudWorkspaceOpError } from "./cloud-workspaces.ts";

/** Codex release whose experimental external-auth protocol is contract-tested. */
export const CODEX_EXTERNAL_AUTH_TOOLCHAIN_VERSION = "0.144.5";

/** Agent providers that can be selected by an E2B cloud workspace. */
export const CloudAuthProvider = Schema.Literals([
	"claude",
	"codex",
	"cursor",
	"grok",
]);
export type CloudAuthProvider = typeof CloudAuthProvider.Type;

export const CloudAuthMethod = Schema.Literals([
	"subscription",
	"api-key",
	"custom",
]);
export type CloudAuthMethod = typeof CloudAuthMethod.Type;

export const CloudAuthProviderState = Schema.Literals([
	"disconnected",
	"authorizing",
	"connected",
	"expired",
	"error",
	"missing-tool",
	"unsupported-for-sandbox",
]);
export type CloudAuthProviderState = typeof CloudAuthProviderState.Type;

export const CloudAuthAuthorityState = Schema.Literals([
	"not-created",
	"provisioning",
	"ready",
	"paused",
	"error",
]);
export type CloudAuthAuthorityState = typeof CloudAuthAuthorityState.Type;

export const CloudCodexAuthFailureCode = Schema.Literals([
	"codex-auth-reconnecting",
	"codex-auth-reconnect-required",
	"codex-auth-update-required",
	"codex-auth-legacy-workspace",
	"codex-auth-outcome-unknown",
]);
export type CloudCodexAuthFailureCode = typeof CloudCodexAuthFailureCode.Type;

export const CodexGrantRefreshReason = Schema.Literals([
	"initial",
	"proactive",
	"unauthorized",
]);
export type CodexGrantRefreshReason = typeof CodexGrantRefreshReason.Type;

export class CodexGrantRequest extends Schema.Class<CodexGrantRequest>(
	"CodexGrantRequest",
)({
	requestId: Schema.String,
	protocolVersion: Schema.Literal(1),
	runtimeGeneration: Schema.Number,
	credentialPublicJwk: Schema.String,
	reason: CodexGrantRefreshReason,
	previousChatgptAccountId: Schema.optional(Schema.String),
}) {}

/** API-routed ciphertext. Only the enrolled runtime RSA key can open it. */
export class SealedCodexGrant extends Schema.Class<SealedCodexGrant>(
	"SealedCodexGrant",
)({
	protocolVersion: Schema.Literal(1),
	requestId: Schema.String,
	keyThumbprint: Schema.String,
	authorityIncarnationId: Schema.String,
	authorityEpoch: Schema.Number,
	/** RSA-OAEP wrapped AES-256 key, base64url. */
	wrappedKey: Schema.String,
	/** AES-GCM nonce, base64url. */
	iv: Schema.String,
	/** AES-GCM ciphertext, including no plaintext provider data. */
	ciphertext: Schema.String,
	/** AES-GCM authentication tag, base64url. */
	tag: Schema.String,
}) {}

export class CloudAuthProviderStatus extends Schema.Class<CloudAuthProviderStatus>(
	"CloudAuthProviderStatus",
)({
	providerId: CloudAuthProvider,
	state: CloudAuthProviderState,
	method: Schema.optional(CloudAuthMethod),
	accountLabel: Schema.optional(Schema.String),
	verifiedAt: Schema.optional(Schema.Number),
	errorCode: Schema.optional(Schema.String),
}) {}

/**
 * Account-owned E2B auth authority status. The public key encrypts credentials
 * directly to the authority; API never receives the corresponding private
 * key or plaintext secret.
 */
export class CloudAuthStatus extends Schema.Class<CloudAuthStatus>(
	"CloudAuthStatus",
)({
	authorityState: CloudAuthAuthorityState,
	providers: Schema.Array(CloudAuthProviderStatus),
	encryptionKeyId: Schema.optional(Schema.String),
	encryptionPublicJwk: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.Number),
}) {}

export class CloudAuthSealedSecret extends Schema.Class<CloudAuthSealedSecret>(
	"CloudAuthSealedSecret",
)({
	keyId: Schema.String,
	ciphertext: Schema.String,
}) {}

export class CloudAuthConfigureRequest extends Schema.Class<CloudAuthConfigureRequest>(
	"CloudAuthConfigureRequest",
)({
	providerId: CloudAuthProvider,
	method: CloudAuthMethod,
	sealedSecret: CloudAuthSealedSecret,
	baseUrl: Schema.optional(Schema.String),
	modelProvider: Schema.optional(Schema.String),
}) {}

export class CloudAuthLoginStartRequest extends Schema.Class<CloudAuthLoginStartRequest>(
	"CloudAuthLoginStartRequest",
)({
	providerId: Schema.Literals(["codex", "grok"]),
}) {}

export class CloudAuthLoginOperation extends Schema.Class<CloudAuthLoginOperation>(
	"CloudAuthLoginOperation",
)({
	operationId: Schema.String,
	providerId: CloudAuthProvider,
	state: Schema.Literals(["authorizing", "connected", "error", "cancelled"]),
	verificationUrl: Schema.optional(Schema.String),
	verificationCode: Schema.optional(Schema.String),
	errorCode: Schema.optional(Schema.String),
}) {}

export const CloudAuthStatusRpc = Rpc.make("cloud.auth.status", {
	payload: Schema.Void,
	success: CloudAuthStatus,
	error: CloudWorkspaceOpError,
});

export const CloudAuthProvisionRpc = Rpc.make("cloud.auth.provision", {
	payload: Schema.Void,
	success: CloudAuthStatus,
	error: CloudWorkspaceOpError,
});

export const CloudAuthConfigureRpc = Rpc.make("cloud.auth.configure", {
	payload: CloudAuthConfigureRequest,
	success: CloudAuthProviderStatus,
	error: CloudWorkspaceOpError,
});

export const CloudAuthLoginStartRpc = Rpc.make("cloud.auth.login.start", {
	payload: CloudAuthLoginStartRequest,
	success: CloudAuthLoginOperation,
	error: CloudWorkspaceOpError,
});

export const CloudAuthLoginPollRpc = Rpc.make("cloud.auth.login.poll", {
	payload: Schema.Struct({ operationId: Schema.String }),
	success: CloudAuthLoginOperation,
	error: CloudWorkspaceOpError,
});

export const CloudAuthLoginCancelRpc = Rpc.make("cloud.auth.login.cancel", {
	payload: Schema.Struct({ operationId: Schema.String }),
	success: CloudAuthLoginOperation,
	error: CloudWorkspaceOpError,
});

export const CloudAuthDisconnectRpc = Rpc.make("cloud.auth.disconnect", {
	payload: Schema.Struct({ providerId: CloudAuthProvider }),
	success: CloudAuthProviderStatus,
	error: CloudWorkspaceOpError,
});
