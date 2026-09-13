import { Effect, Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

import { EnvironmentEndpoint } from "./connect.ts";
import { EnvironmentId } from "./ids.ts";

// ---------------------------------------------------------------------------
// Managed cloud machines
// ---------------------------------------------------------------------------

export const PERSISTENT_STANDARD_OFFER_ID = "persistent-standard-v1" as const;

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

export class MachineOfferList extends Schema.Class<MachineOfferList>(
	"MachineOfferList",
)({
	offers: Schema.Array(MachineOffer),
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
 * inside the api and are never exposed through this contract.
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

export class MachineEnrollResponse extends Schema.Class<MachineEnrollResponse>(
	"MachineEnrollResponse",
)({
	environmentId: EnvironmentId,
	endpoint: EnvironmentEndpoint,
	apiIssuer: Schema.String,
	environmentCredential: Schema.String,
	mintPublicKey: Schema.String,
	tunnelHostname: Schema.optional(Schema.String),
	connectorToken: Schema.optional(Schema.String),
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
	"beta-access-required",
	"beta-access-unavailable",
	"invalid-offer",
	"invalid-state",
	"entitlement-required",
	"machine-limit-reached",
	"billing-unavailable",
	"provider-unavailable",
	"tunnel-unavailable",
	"enrollment-expired",
	"enrollment-rejected",
	"credential-required",
	"branch-in-use",
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

export class MachineResourceSample extends Schema.Class<MachineResourceSample>(
	"MachineResourceSample",
)({
	sampledAt: Schema.Number,
	cpuCores: Schema.Number,
	cpuPercent: Schema.Number,
	memTotalBytes: Schema.Number,
	memUsedBytes: Schema.Number,
	diskTotalBytes: Schema.Number,
	diskUsedBytes: Schema.Number,
	/** Filesystem the disk numbers describe (the workspace root when present). */
	diskPath: Schema.String,
}) {}

export const MachineResourcesWatchRpc = Rpc.make("machine.resources.watch", {
	payload: Schema.Struct({ intervalMs: Schema.optional(Schema.Number) }),
	success: MachineResourceSample,
	error: MachineOpError,
	stream: true,
});

// ---------------------------------------------------------------------------
// Cloud-machine account access
// ---------------------------------------------------------------------------

export const AccountAccessProvider = Schema.Literals([
	"claude",
	"codex",
	"cursor",
	"grok",
]);
export type AccountAccessProvider = typeof AccountAccessProvider.Type;

export const AccountAccessState = Schema.Literals([
	"missing-tool",
	"disconnected",
	"authorizing",
	"connected",
	"expired",
	"error",
]);
export type AccountAccessState = typeof AccountAccessState.Type;

export const AccountAccessAuthKind = Schema.Literals([
	"subscription",
	"api-key",
	"custom",
]);
export type AccountAccessAuthKind = typeof AccountAccessAuthKind.Type;

export class AccountAccessProviderStatus extends Schema.Class<AccountAccessProviderStatus>(
	"AccountAccessProviderStatus",
)({
	providerId: AccountAccessProvider,
	state: AccountAccessState,
	installed: Schema.Boolean,
	accountLabel: Schema.optional(Schema.String),
	authMethod: Schema.optional(AccountAccessAuthKind),
	verifiedAt: Schema.optional(Schema.Number),
	errorCode: Schema.optional(Schema.String),
}) {}

export class AccountAccessStatus extends Schema.Class<AccountAccessStatus>(
	"AccountAccessStatus",
)({
	providers: Schema.Array(AccountAccessProviderStatus),
}) {}

export const AccountAccessTransferEvent = Schema.Union([
	Schema.TaggedStruct("progress", { message: Schema.String }),
	Schema.TaggedStruct("verification", {
		url: Schema.String,
		code: Schema.optional(Schema.String),
	}),
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
	"credential-store-failed",
	"cleanup-failed",
	"invalid-credential",
	"invalid-configuration",
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

export const AccountAccessStartLoginRpc = Rpc.make("accountAccess.startLogin", {
	payload: Schema.Struct({
		providerId: Schema.Literals(["codex", "cursor", "grok"]),
	}),
	success: AccountAccessTransferEvent,
	error: AccountAccessOpError,
	stream: true,
});

export class AccountAccessSetCredentialRequest extends Schema.Class<AccountAccessSetCredentialRequest>(
	"AccountAccessSetCredentialRequest",
)({
	providerId: AccountAccessProvider,
	method: Schema.Literals(["subscription", "api-key"]),
	secret: Schema.String,
}) {}

export const AccountAccessSetCredentialRpc = Rpc.make(
	"accountAccess.setCredential",
	{
		payload: AccountAccessSetCredentialRequest,
		success: AccountAccessProviderStatus,
		error: AccountAccessOpError,
	},
);

export class AccountAccessCustomConfigRequest extends Schema.Class<AccountAccessCustomConfigRequest>(
	"AccountAccessCustomConfigRequest",
)({
	providerId: AccountAccessProvider,
	baseUrl: Schema.String,
	secret: Schema.String,
	modelProvider: Schema.optional(Schema.String),
}) {}

export const AccountAccessConfigureCustomRpc = Rpc.make(
	"accountAccess.configureCustom",
	{
		payload: AccountAccessCustomConfigRequest,
		success: AccountAccessProviderStatus,
		error: AccountAccessOpError,
	},
);

export const AccountAccessDisconnectRpc = Rpc.make("accountAccess.disconnect", {
	payload: Schema.Struct({ providerId: AccountAccessProvider }),
	success: AccountAccessProviderStatus,
	error: AccountAccessOpError,
});
