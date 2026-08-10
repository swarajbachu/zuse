import { Effect, Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

import { EnvironmentEndpoint } from "./connect.ts";
import { EnvironmentId } from "./ids.ts";

// ---------------------------------------------------------------------------
// Managed cloud machines
// ---------------------------------------------------------------------------

export const PERSISTENT_STANDARD_OFFER_ID = "persistent-standard-v1" as const;
export const SANDBOX_STANDARD_OFFER_ID = "sandbox-standard-v1" as const;

export const MachineArchitecture = Schema.Literals(["x86_64"]);
export type MachineArchitecture = typeof MachineArchitecture.Type;

export const MachineOfferKind = Schema.Literals(["persistent", "sandbox"]);
export type MachineOfferKind = typeof MachineOfferKind.Type;

export class MachineOffer extends Schema.Class<MachineOffer>("MachineOffer")({
	offerId: Schema.String,
	kind: MachineOfferKind.pipe(
		Schema.withDecodingDefaultKey(Effect.succeed("persistent" as const)),
	),
	displayName: Schema.String,
	architecture: MachineArchitecture,
	vcpuCount: Schema.Number,
	memoryMib: Schema.Number,
	diskGib: Schema.Number,
	location: Schema.String,
	monthlyPriceCents: Schema.Number,
	currency: Schema.String,
	automaticBackups: Schema.Boolean,
	available: Schema.Boolean,
}) {}

export class SandboxProviderOption extends Schema.Class<SandboxProviderOption>(
	"SandboxProviderOption",
)({
	providerId: Schema.String,
	displayName: Schema.String,
	default: Schema.Boolean,
}) {}

export class MachineOfferList extends Schema.Class<MachineOfferList>(
	"MachineOfferList",
)({
	offers: Schema.Array(MachineOffer),
	sandboxProviders: Schema.Array(SandboxProviderOption).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed([])),
	),
}) {}

export const MachineState = Schema.Literals([
	"creating",
	"bootstrapping",
	"enrolling",
	"ready",
	"suspending",
	"suspended",
	"resuming",
	"destroying",
	"destroyed",
	"failed",
]);
export type MachineState = typeof MachineState.Type;

export const DesiredMachineState = Schema.Literals([
	"ready",
	"suspended",
	"destroyed",
]);
export type DesiredMachineState = typeof DesiredMachineState.Type;

/**
 * Stable, user-safe status codes. Provider responses and raw errors are kept
 * inside the relay and are never exposed through this contract.
 */
export const MachineStatusCode = Schema.Literals([
	"creation-queued",
	"provider-provisioning",
	"bootstrap-pending",
	"enrollment-pending",
	"ready",
	"suspension-queued",
	"suspended",
	"resume-queued",
	"cancellation-scheduled",
	"recovery-available",
	"destruction-queued",
	"destroyed",
	"provider-unavailable",
	"bootstrap-failed",
	"enrollment-failed",
	"reconciliation-failed",
]);
export type MachineStatusCode = typeof MachineStatusCode.Type;

export const MachineBootPhase = Schema.Literals([
	"bootstrap-started",
	"runtime-installed",
	"developer-tools-installed",
	"zuse-started",
	"account-setup-available",
	"service-started",
	"failed",
]);
export type MachineBootPhase = typeof MachineBootPhase.Type;

export class MachineRecord extends Schema.Class<MachineRecord>("MachineRecord")(
	{
		machineId: Schema.String,
		offer: MachineOffer,
		label: Schema.optional(Schema.String),
		state: MachineState,
		desiredState: DesiredMachineState,
		statusCode: MachineStatusCode,
		bootPhase: Schema.optional(MachineBootPhase),
		sandboxProviderId: Schema.optional(Schema.String),
		environmentId: Schema.optional(EnvironmentId),
		createdAt: Schema.Number,
		paidThrough: Schema.optional(Schema.Number),
		recoveryDeadline: Schema.optional(Schema.Number),
	},
) {}

export class MachineList extends Schema.Class<MachineList>("MachineList")({
	machines: Schema.Array(MachineRecord),
}) {}

export class MachineCreateRequest extends Schema.Class<MachineCreateRequest>(
	"MachineCreateRequest",
)({
	offerId: Schema.String,
	sandboxProviderId: Schema.optional(Schema.String),
	label: Schema.optional(Schema.String),
	idempotencyKey: Schema.String,
}) {}

export class MachineIdRequest extends Schema.Class<MachineIdRequest>(
	"MachineIdRequest",
)({
	machineId: Schema.String,
}) {}

export class MachineDestroyRequest extends Schema.Class<MachineDestroyRequest>(
	"MachineDestroyRequest",
)({
	machineId: Schema.String,
	confirmation: Schema.Literal("destroy"),
}) {}

// --- enrollment -------------------------------------------------------------

export class MachineEnrollRequest extends Schema.Class<MachineEnrollRequest>(
	"MachineEnrollRequest",
)({
	machineId: Schema.String,
	environmentId: EnvironmentId,
	environmentPublicKey: Schema.String,
	proof: Schema.String,
	endpoint: EnvironmentEndpoint,
	origin: Schema.Struct({
		localHttpHost: Schema.String,
		localHttpPort: Schema.Number,
	}),
	label: Schema.optional(Schema.String),
}) {}

export class CloudRuntimeCredential extends Schema.Class<CloudRuntimeCredential>(
	"CloudRuntimeCredential",
)({
	kind: Schema.Literals(["github", "claude", "codex"]),
	credentialType: Schema.Literals([
		"api-key",
		"oauth-token",
		"repository-token",
	]),
	secret: Schema.String,
	version: Schema.Number,
}) {}

export class MachineEnrollResponse extends Schema.Class<MachineEnrollResponse>(
	"MachineEnrollResponse",
)({
	environmentId: EnvironmentId,
	endpoint: EnvironmentEndpoint,
	relayIssuer: Schema.String,
	environmentCredential: Schema.String,
	mintPublicKey: Schema.String,
	tunnelHostname: Schema.optional(Schema.String),
	connectorToken: Schema.optional(Schema.String),
	cloudCredentials: Schema.optional(Schema.Array(CloudRuntimeCredential)),
}) {}

export class MachineBootStatusRequest extends Schema.Class<MachineBootStatusRequest>(
	"MachineBootStatusRequest",
)({
	phase: MachineBootPhase,
	statusCode: Schema.optional(MachineStatusCode),
}) {}

// --- billing and entitlements -----------------------------------------------

export const EntitlementKind = Schema.Literals([
	"persistent-machine",
	"cloud-workspace",
	"usage-credits",
]);
export type EntitlementKind = typeof EntitlementKind.Type;

export const EntitlementStatus = Schema.Literals([
	"pending",
	"active",
	"grace",
	"ended",
]);
export type EntitlementStatus = typeof EntitlementStatus.Type;

export class EntitlementRecord extends Schema.Class<EntitlementRecord>(
	"EntitlementRecord",
)({
	entitlementId: Schema.String,
	kind: EntitlementKind,
	status: EntitlementStatus,
	offerId: Schema.optional(Schema.String),
	machineId: Schema.optional(Schema.String),
	paidThrough: Schema.optional(Schema.Number),
	creditBalance: Schema.optional(Schema.Number),
}) {}

export class EntitlementList extends Schema.Class<EntitlementList>(
	"EntitlementList",
)({
	entitlements: Schema.Array(EntitlementRecord),
}) {}

export class BillingCheckoutRequest extends Schema.Class<BillingCheckoutRequest>(
	"BillingCheckoutRequest",
)({
	offerId: Schema.String,
	sandboxProviderId: Schema.optional(Schema.String),
}) {}

export class BillingCheckout extends Schema.Class<BillingCheckout>(
	"BillingCheckout",
)({
	checkoutUrl: Schema.String,
}) {}

export class BillingPortal extends Schema.Class<BillingPortal>("BillingPortal")(
	{
		portalUrl: Schema.String,
	},
) {}

// --- client-visible errors --------------------------------------------------

export const MachineErrorCode = Schema.Literals([
	"not-found",
	"not-allowed",
	"invalid-offer",
	"invalid-state",
	"entitlement-required",
	"machine-limit-reached",
	"billing-unavailable",
	"provider-unavailable",
	"enrollment-expired",
	"enrollment-rejected",
	"conflict",
	"invalid-request",
]);
export type MachineErrorCode = typeof MachineErrorCode.Type;

export class MachineOpError extends Schema.TaggedErrorClass<MachineOpError>()(
	"MachineOpError",
	{
		code: MachineErrorCode,
	},
) {}

// ---------------------------------------------------------------------------
// Desktop control-plane RPCs
// ---------------------------------------------------------------------------

export const MachinesOffersRpc = Rpc.make("machines.offers", {
	payload: Schema.Void,
	success: MachineOfferList,
	error: MachineOpError,
});

export const MachinesListRpc = Rpc.make("machines.list", {
	payload: Schema.Void,
	success: MachineList,
	error: MachineOpError,
});

export const MachinesGetRpc = Rpc.make("machines.get", {
	payload: MachineIdRequest,
	success: MachineRecord,
	error: MachineOpError,
});

export const MachinesCreateRpc = Rpc.make("machines.create", {
	payload: MachineCreateRequest,
	success: MachineRecord,
	error: MachineOpError,
});

export const MachinesCancelRpc = Rpc.make("machines.cancel", {
	payload: MachineIdRequest,
	success: MachineRecord,
	error: MachineOpError,
});

export const MachinesRecoverRpc = Rpc.make("machines.recover", {
	payload: MachineIdRequest,
	success: MachineRecord,
	error: MachineOpError,
});

export const MachinesDestroyRpc = Rpc.make("machines.destroy", {
	payload: MachineDestroyRequest,
	success: MachineRecord,
	error: MachineOpError,
});

export const MachinesCheckoutRpc = Rpc.make("machines.checkout", {
	payload: BillingCheckoutRequest,
	success: BillingCheckout,
	error: MachineOpError,
});

export const MachinesBillingPortalRpc = Rpc.make("machines.billingPortal", {
	payload: Schema.Void,
	success: BillingPortal,
	error: MachineOpError,
});

export const MachinesEntitlementsRpc = Rpc.make("machines.entitlements", {
	payload: Schema.Void,
	success: EntitlementList,
	error: MachineOpError,
});

// ---------------------------------------------------------------------------
// RPCs served by a cloud machine
// ---------------------------------------------------------------------------

export const SshMode = Schema.Literals(["authorized-keys", "tailnet-identity"]);
export type SshMode = typeof SshMode.Type;

export class MachineSshKey extends Schema.Class<MachineSshKey>("MachineSshKey")(
	{
		fingerprint: Schema.String,
		publicKey: Schema.String,
		label: Schema.optional(Schema.String),
	},
) {}

export class MachineSshKeysAddRpcPayload extends Schema.Class<MachineSshKeysAddRpcPayload>(
	"MachineSshKeysAddRpcPayload",
)({
	publicKey: Schema.String,
	label: Schema.optional(Schema.String),
}) {}

export const MachineSshKeysAddRpc = Rpc.make("machine.sshKeys.add", {
	payload: MachineSshKeysAddRpcPayload,
	success: MachineSshKey,
	error: MachineOpError,
});

export const MachineSshKeysListRpc = Rpc.make("machine.sshKeys.list", {
	payload: Schema.Void,
	success: Schema.Struct({ keys: Schema.Array(MachineSshKey) }),
	error: MachineOpError,
});

export const MachineSshKeysRemoveRpc = Rpc.make("machine.sshKeys.remove", {
	payload: Schema.Struct({ fingerprint: Schema.String }),
	success: Schema.Void,
	error: MachineOpError,
});

export class MachinePrivateNetworkStatus extends Schema.Class<MachinePrivateNetworkStatus>(
	"MachinePrivateNetworkStatus",
)({
	enabled: Schema.Boolean,
	privateIp: Schema.optional(Schema.String),
	dnsName: Schema.optional(Schema.String),
	sshMode: SshMode,
}) {}

export const MachinePrivateNetworkEnableRpc = Rpc.make(
	"machine.privateNetwork.enable",
	{
		payload: Schema.Struct({
			authKey: Schema.String,
			sshMode: SshMode,
		}),
		success: MachinePrivateNetworkStatus,
		error: MachineOpError,
	},
);

export const MachinePrivateNetworkStatusRpc = Rpc.make(
	"machine.privateNetwork.status",
	{
		payload: Schema.Void,
		success: MachinePrivateNetworkStatus,
		error: MachineOpError,
	},
);

export const MachineSshModeSetRpc = Rpc.make("machine.sshMode.set", {
	payload: Schema.Struct({ mode: SshMode }),
	success: MachinePrivateNetworkStatus,
	error: MachineOpError,
});

export const MachineRuntimeUpdateState = Schema.Literals([
	"current",
	"update-available",
	"updating",
	"failed",
	"unavailable",
]);
export type MachineRuntimeUpdateState = typeof MachineRuntimeUpdateState.Type;

export const MachineRuntimeUpdatePhase = Schema.Literals([
	"idle",
	"checking",
	"queued",
	"downloading",
	"installing",
	"developer-tools",
	"restarting",
	"verifying",
	"complete",
	"rolling-back",
	"failed",
]);
export type MachineRuntimeUpdatePhase = typeof MachineRuntimeUpdatePhase.Type;

export const MachineRuntimeUpdateFailureCode = Schema.Literals([
	"check-failed",
	"target-version-unavailable",
	"install-failed",
	"health-check-failed",
	"rollback-complete",
]);
export type MachineRuntimeUpdateFailureCode =
	typeof MachineRuntimeUpdateFailureCode.Type;

export class MachineRuntimeStatus extends Schema.Class<MachineRuntimeStatus>(
	"MachineRuntimeStatus",
)({
	state: MachineRuntimeUpdateState,
	phase: MachineRuntimeUpdatePhase,
	progressPercent: Schema.Number,
	targetAppVersion: Schema.String,
	installedAppVersion: Schema.optional(Schema.String),
	installedRuntimeVersion: Schema.optional(Schema.String),
	targetRuntimeVersion: Schema.optional(Schema.String),
	updatedAt: Schema.optional(Schema.Number),
	failureCode: Schema.optional(MachineRuntimeUpdateFailureCode),
}) {}

export const MachineRuntimeTargetRpc = Rpc.make("machine.runtime.target", {
	payload: Schema.Void,
	success: Schema.Struct({ appVersion: Schema.String }),
	error: MachineOpError,
});

export const MachineRuntimeStatusRpc = Rpc.make("machine.runtime.status", {
	payload: Schema.Struct({ targetAppVersion: Schema.String }),
	success: MachineRuntimeStatus,
	error: MachineOpError,
});

export const MachineRuntimeUpdateRpc = Rpc.make("machine.runtime.update", {
	payload: Schema.Struct({ targetAppVersion: Schema.String }),
	success: MachineRuntimeStatus,
	error: MachineOpError,
});

// ---------------------------------------------------------------------------
// Cloud-machine account access
// ---------------------------------------------------------------------------

export const AccountAccessProvider = Schema.Literals([
	"github",
	"claude",
	"codex",
]);
export type AccountAccessProvider = typeof AccountAccessProvider.Type;

export const AccountAccessState = Schema.Literals([
	"missing-tool",
	"disconnected",
	"authorizing",
	"connected",
	"error",
]);
export type AccountAccessState = typeof AccountAccessState.Type;

export const AccountAccessAuthKind = Schema.Literals([
	"device",
	"api-key",
	"oauth-token",
]);
export type AccountAccessAuthKind = typeof AccountAccessAuthKind.Type;

export class AccountAccessProviderStatus extends Schema.Class<AccountAccessProviderStatus>(
	"AccountAccessProviderStatus",
)({
	providerId: AccountAccessProvider,
	state: AccountAccessState,
	installed: Schema.Boolean,
	accountLabel: Schema.optional(Schema.String),
	authKind: Schema.optional(AccountAccessAuthKind),
	lastSyncedAt: Schema.optional(Schema.Number),
	errorCode: Schema.optional(Schema.String),
}) {}

export class AccountAccessStatus extends Schema.Class<AccountAccessStatus>(
	"AccountAccessStatus",
)({
	providers: Schema.Array(AccountAccessProviderStatus),
}) {}

export class LocalAccountDescriptor extends Schema.Class<LocalAccountDescriptor>(
	"LocalAccountDescriptor",
)({
	providerId: AccountAccessProvider,
	installed: Schema.Boolean,
	detected: Schema.Boolean,
	accountLabel: Schema.optional(Schema.String),
	action: Schema.Literals(["device-login", "sealed-transfer"]),
}) {}

export class LocalAccountDescriptorList extends Schema.Class<LocalAccountDescriptorList>(
	"LocalAccountDescriptorList",
)({
	accounts: Schema.Array(LocalAccountDescriptor),
}) {}

export class AccountAccessPreparedImport extends Schema.Class<AccountAccessPreparedImport>(
	"AccountAccessPreparedImport",
)({
	transferId: Schema.String,
	accountId: Schema.String,
	environmentId: EnvironmentId,
	recipientPublicKey: Schema.String,
	expiresAt: Schema.Number,
	environmentProof: Schema.String,
}) {}

export class AccountAccessSealedCredential extends Schema.Class<AccountAccessSealedCredential>(
	"AccountAccessSealedCredential",
)({
	ephemeralPublicKey: Schema.String,
	nonce: Schema.String,
	ciphertext: Schema.String,
}) {}

export class AccountAccessCreateClaudeTransferRequest extends Schema.Class<AccountAccessCreateClaudeTransferRequest>(
	"AccountAccessCreateClaudeTransferRequest",
)({
	prepared: AccountAccessPreparedImport,
}) {}

export const AccountAccessClaudeTransferContinuation = Schema.Union([
	Schema.TaggedStruct("code", {
		transferId: Schema.String,
		code: Schema.String,
	}),
	Schema.TaggedStruct("cancel", {
		transferId: Schema.String,
	}),
]);
export type AccountAccessClaudeTransferContinuation =
	typeof AccountAccessClaudeTransferContinuation.Type;

export class AccountAccessImportRequest extends Schema.Class<AccountAccessImportRequest>(
	"AccountAccessImportRequest",
)({
	transferId: Schema.String,
	sealed: AccountAccessSealedCredential,
}) {}

export const AccountAccessTransferEvent = Schema.Union([
	Schema.TaggedStruct("progress", { message: Schema.String }),
	Schema.TaggedStruct("input-ready", {}),
	Schema.TaggedStruct("verification", {
		url: Schema.String,
		code: Schema.optional(Schema.String),
	}),
	Schema.TaggedStruct("sealed", { sealed: AccountAccessSealedCredential }),
	Schema.TaggedStruct("done", {
		ok: Schema.Boolean,
		reason: Schema.optional(Schema.String),
	}),
]);
export type AccountAccessTransferEvent = typeof AccountAccessTransferEvent.Type;

export const AccountAccessErrorCode = Schema.Literals([
	"not-allowed",
	"not-signed-in",
	"unsupported-provider",
	"tool-not-installed",
	"login-failed",
	"transfer-expired",
	"transfer-replayed",
	"transfer-rejected",
	"credential-store-failed",
	"cleanup-failed",
]);
export type AccountAccessErrorCode = typeof AccountAccessErrorCode.Type;

export class AccountAccessOpError extends Schema.TaggedErrorClass<AccountAccessOpError>()(
	"AccountAccessOpError",
	{ code: AccountAccessErrorCode },
) {}

export const AccountAccessStatusRpc = Rpc.make("accountAccess.status", {
	payload: Schema.Void,
	success: AccountAccessStatus,
	error: AccountAccessOpError,
});

export const AccountAccessDetectLocalRpc = Rpc.make(
	"accountAccess.detectLocal",
	{
		payload: Schema.Void,
		success: LocalAccountDescriptorList,
		error: AccountAccessOpError,
	},
);

export const AccountAccessStartLoginRpc = Rpc.make("accountAccess.startLogin", {
	payload: Schema.Struct({
		providerId: Schema.Literals(["github", "codex"]),
	}),
	success: AccountAccessTransferEvent,
	error: AccountAccessOpError,
	stream: true,
});

export const AccountAccessPrepareImportRpc = Rpc.make(
	"accountAccess.prepareImport",
	{
		payload: Schema.Struct({
			accountId: Schema.String,
			providerId: Schema.Literal("claude"),
		}),
		success: AccountAccessPreparedImport,
		error: AccountAccessOpError,
	},
);

export const AccountAccessCreateClaudeTransferRpc = Rpc.make(
	"accountAccess.createClaudeTransfer",
	{
		payload: AccountAccessCreateClaudeTransferRequest,
		success: AccountAccessTransferEvent,
		error: AccountAccessOpError,
		stream: true,
	},
);

export const AccountAccessContinueClaudeTransferRpc = Rpc.make(
	"accountAccess.continueClaudeTransfer",
	{
		payload: AccountAccessClaudeTransferContinuation,
		success: Schema.Void,
		error: AccountAccessOpError,
	},
);

export const AccountAccessImportRpc = Rpc.make("accountAccess.import", {
	payload: AccountAccessImportRequest,
	success: AccountAccessProviderStatus,
	error: AccountAccessOpError,
});

export const AccountAccessDisconnectRpc = Rpc.make("accountAccess.disconnect", {
	payload: Schema.Struct({ providerId: AccountAccessProvider }),
	success: AccountAccessProviderStatus,
	error: AccountAccessOpError,
});
