import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { CloudWorkspaceOpError } from "./cloud-workspaces.ts";

export const CloudBillingStatus = Schema.Literals([
	"active",
	"grace",
	"billing-hold",
	"ended",
	"manual",
]);
export type CloudBillingStatus = typeof CloudBillingStatus.Type;

export class CloudBillingSummary extends Schema.Class<CloudBillingSummary>(
	"CloudBillingSummary",
)({
	currency: Schema.Literal("USD"),
	status: CloudBillingStatus,
	periodStart: Schema.Number,
	periodEnd: Schema.Number,
	basePriceMicros: Schema.Number,
	includedProviderCostMicros: Schema.Number,
	providerCostMicros: Schema.Number,
	includedUsedMicros: Schema.Number,
	includedRemainingMicros: Schema.Number,
	overageProviderCostMicros: Schema.Number,
	overageChargeMicros: Schema.Number,
	overageCapMicros: Schema.Number,
	markupBasisPoints: Schema.Number,
	currentInvoiceEstimateMicros: Schema.Number,
	lastProviderReconciledAt: Schema.optional(Schema.Number),
	lastPolarReconciledAt: Schema.optional(Schema.Number),
	usageProvisional: Schema.Boolean,
}) {}

export class CloudBillingUsageItem extends Schema.Class<CloudBillingUsageItem>(
	"CloudBillingUsageItem",
)({
	entryId: Schema.String,
	resourceKind: Schema.Literals(["workspace", "build", "other"]),
	resourceId: Schema.String,
	provider: Schema.String,
	providerExecutionId: Schema.optional(Schema.String),
	startedAt: Schema.Number,
	endedAt: Schema.Number,
	vcpuCount: Schema.Number,
	memoryMib: Schema.Number,
	providerCostMicros: Schema.Number,
	status: Schema.Literals(["provisional", "confirmed", "corrected"]),
}) {}

export class CloudBillingUsagePage extends Schema.Class<CloudBillingUsagePage>(
	"CloudBillingUsagePage",
)({
	items: Schema.Array(CloudBillingUsageItem),
	nextCursor: Schema.optional(Schema.String),
}) {}

export class CloudBillingUsageRequest extends Schema.Class<CloudBillingUsageRequest>(
	"CloudBillingUsageRequest",
)({
	cursor: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.Number),
}) {}

export class CloudBillingCapRequest extends Schema.Class<CloudBillingCapRequest>(
	"CloudBillingCapRequest",
)({
	overageCapMicros: Schema.Number,
	idempotencyKey: Schema.String,
}) {}

export const CloudBillingSummaryRpc = Rpc.make("cloud.billing.summary", {
	payload: Schema.Void,
	success: CloudBillingSummary,
	error: CloudWorkspaceOpError,
});

export const CloudBillingUsageRpc = Rpc.make("cloud.billing.usage", {
	payload: CloudBillingUsageRequest,
	success: CloudBillingUsagePage,
	error: CloudWorkspaceOpError,
});

export const CloudBillingSetCapRpc = Rpc.make("cloud.billing.setCap", {
	payload: CloudBillingCapRequest,
	success: CloudBillingSummary,
	error: CloudWorkspaceOpError,
});
