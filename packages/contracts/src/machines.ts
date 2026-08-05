import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

import { EnvironmentEndpoint } from "./connect.ts";
import { EnvironmentId } from "./ids.ts";

// ---------------------------------------------------------------------------
// Managed cloud machines
// ---------------------------------------------------------------------------

export const PERSISTENT_STANDARD_OFFER_ID = "persistent-standard-v1" as const;

export const MachineArchitecture = Schema.Literals(["x86_64"]);
export type MachineArchitecture = typeof MachineArchitecture.Type;

export class MachineOffer extends Schema.Class<MachineOffer>("MachineOffer")({
	offerId: Schema.String,
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

export class MachineRecord extends Schema.Class<MachineRecord>("MachineRecord")(
	{
		machineId: Schema.String,
		offer: MachineOffer,
		label: Schema.optional(Schema.String),
		state: MachineState,
		desiredState: DesiredMachineState,
		statusCode: MachineStatusCode,
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
	relayIssuer: Schema.String,
	environmentCredential: Schema.String,
	mintPublicKey: Schema.String,
	tunnelHostname: Schema.optional(Schema.String),
	connectorToken: Schema.optional(Schema.String),
}) {}

export const MachineBootPhase = Schema.Literals([
	"bootstrap-started",
	"runtime-installed",
	"service-started",
	"failed",
]);
export type MachineBootPhase = typeof MachineBootPhase.Type;

export class MachineBootStatusRequest extends Schema.Class<MachineBootStatusRequest>(
	"MachineBootStatusRequest",
)({
	phase: MachineBootPhase,
	statusCode: Schema.optional(MachineStatusCode),
}) {}

// --- billing and entitlements -----------------------------------------------

export const EntitlementKind = Schema.Literals([
	"persistent-machine",
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
	successUrl: Schema.String,
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
