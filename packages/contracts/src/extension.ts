import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { ProviderId } from "./agent.ts";
import { AgentSessionId, FolderId, WorktreeId } from "./ids.ts";

export const ExtensionId = Schema.String.check(
	Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/),
);
export type ExtensionId = typeof ExtensionId.Type;

export const ExtensionCapability = Schema.Literals([
	"attachments",
	"commands",
	"credentials",
	"filesystem",
	"network",
	"process",
	"providers",
	"rpc",
	"storage",
	"themes",
	"timeline",
	"ui",
]);
export type ExtensionCapability = typeof ExtensionCapability.Type;

export const ExtensionContributionKind = Schema.Literals([
	"attachment-source",
	"command",
	"provider",
	"sidebar-item",
	"surface",
	"theme",
	"timeline-renderer",
	"timeline-transformer",
	"workspace-panel",
]);
export type ExtensionContributionKind = typeof ExtensionContributionKind.Type;

const Semver = Schema.String.check(
	Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
);

export const ExtensionManifest = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	id: ExtensionId,
	name: Schema.NonEmptyString,
	description: Schema.String,
	version: Semver,
	entry: Schema.optional(Schema.String),
	client: Schema.optional(Schema.String),
	server: Schema.optional(Schema.String),
	zuseApi: Schema.NonEmptyString,
	homepage: Schema.optional(Schema.String),
	repository: Schema.optional(Schema.String),
	contributions: Schema.Array(ExtensionContributionKind),
	capabilities: Schema.Array(ExtensionCapability),
	publisher: Schema.Struct({
		name: Schema.NonEmptyString,
		url: Schema.optional(Schema.String),
	}),
});
export type ExtensionManifest = typeof ExtensionManifest.Type;

export const ExtensionSource = Schema.Union([
	Schema.TaggedStruct("directory", { path: Schema.String }),
	Schema.TaggedStruct("git", {
		url: Schema.String,
		ref: Schema.optional(Schema.String),
		path: Schema.optional(Schema.String),
	}),
	Schema.TaggedStruct("marketplace", { catalogId: ExtensionId }),
]);
export type ExtensionSource = typeof ExtensionSource.Type;

export const ExtensionStatus = Schema.Literals([
	"disabled",
	"failed",
	"loading",
	"running",
	"update-available",
]);
export type ExtensionStatus = typeof ExtensionStatus.Type;

export const ExtensionProviderDescriptor = Schema.Struct({
	id: ProviderId,
	displayName: Schema.String,
	iconAssetUrl: Schema.NullOr(Schema.String),
	order: Schema.Number,
	authentication: Schema.Union([
		Schema.TaggedStruct("none", {}),
		Schema.TaggedStruct("api-key", {
			label: Schema.String,
			placeholder: Schema.NullOr(Schema.String),
		}),
		Schema.TaggedStruct("extension-managed", {
			settingsSurfaceId: Schema.String,
		}),
	]),
	capabilities: Schema.Array(
		Schema.Literals([
			"answerQuestion",
			"fork",
			"goals",
			"mcp",
			"planApproval",
			"resume",
		]),
	),
	models: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			label: Schema.String,
			defaultVisible: Schema.Boolean,
			defaultModel: Schema.Boolean,
			supportsPlanMode: Schema.Boolean,
			supportsWebSearch: Schema.NullOr(
				Schema.Literals(["native", "queryOnly"]),
			),
		}),
	),
});
export type ExtensionProviderDescriptor =
	typeof ExtensionProviderDescriptor.Type;

export const ExtensionListItem = Schema.Struct({
	id: ExtensionId,
	manifest: ExtensionManifest,
	source: ExtensionSource,
	status: ExtensionStatus,
	enabled: Schema.Boolean,
	grantedCapabilities: Schema.Array(ExtensionCapability),
	activeCommit: Schema.NullOr(Schema.String),
	availableCommit: Schema.NullOr(Schema.String),
	error: Schema.NullOr(Schema.String),
	providers: Schema.Array(ExtensionProviderDescriptor),
	clientBundle: Schema.NullOr(Schema.String),
	clientCss: Schema.String,
});
export type ExtensionListItem = typeof ExtensionListItem.Type;

export const ExtensionCatalog = Schema.Struct({
	globallyEnabled: Schema.Boolean,
	knownProviders: Schema.optional(Schema.Array(ExtensionProviderDescriptor)),
	items: Schema.Array(ExtensionListItem),
});
export type ExtensionCatalog = typeof ExtensionCatalog.Type;

export const MarketplaceExtension = Schema.Struct({
	id: ExtensionId,
	manifest: ExtensionManifest,
	commit: Schema.String,
	archiveUrl: Schema.String,
	sha256: Schema.String,
	changelog: Schema.String,
	installed: Schema.Boolean,
	updateAvailable: Schema.Boolean,
});
export type MarketplaceExtension = typeof MarketplaceExtension.Type;

export const ExtensionLogEntry = Schema.Struct({
	sequence: Schema.Number,
	timestamp: Schema.String,
	stream: Schema.Literals(["stdout", "stderr"]),
	message: Schema.String,
});
export type ExtensionLogEntry = typeof ExtensionLogEntry.Type;

export class ExtensionError extends Schema.TaggedErrorClass<ExtensionError>()(
	"ExtensionError",
	{
		code: Schema.Literals([
			"already-installed",
			"busy",
			"unsupported-environment",
			"capability-approval-required",
			"compile-failed",
			"incompatible",
			"integrity-failed",
			"invalid-manifest",
			"invalid-source",
			"not-found",
			"not-running",
			"rpc-failed",
			"signature-failed",
			"startup-failed",
		]),
		extensionId: Schema.NullOr(Schema.String),
		reason: Schema.String,
	},
) {}

export const ExtensionCatalogGetRpc = Rpc.make("extension.catalog", {
	success: ExtensionCatalog,
	error: ExtensionError,
});

export const ExtensionCatalogStreamRpc = Rpc.make("extension.catalog.stream", {
	success: ExtensionCatalog,
	error: ExtensionError,
	stream: true,
});

export const ExtensionSetGlobalEnabledRpc = Rpc.make(
	"extension.setGlobalEnabled",
	{
		payload: Schema.Struct({ enabled: Schema.Boolean }),
		success: ExtensionCatalog,
		error: ExtensionError,
	},
);

export const ExtensionInspectRpc = Rpc.make("extension.inspect", {
	payload: Schema.Struct({ source: ExtensionSource }),
	success: ExtensionManifest,
	error: ExtensionError,
});

export const ExtensionInstallRpc = Rpc.make("extension.install", {
	payload: Schema.Struct({
		source: ExtensionSource,
		grantedCapabilities: Schema.Array(ExtensionCapability),
	}),
	success: ExtensionListItem,
	error: ExtensionError,
});

const ExtensionIdPayload = Schema.Struct({ id: ExtensionId });

export const ExtensionEnableRpc = Rpc.make("extension.enable", {
	payload: ExtensionIdPayload,
	success: ExtensionListItem,
	error: ExtensionError,
});
export const ExtensionDisableRpc = Rpc.make("extension.disable", {
	payload: ExtensionIdPayload,
	success: ExtensionListItem,
	error: ExtensionError,
});
export const ExtensionReloadRpc = Rpc.make("extension.reload", {
	payload: ExtensionIdPayload,
	success: ExtensionListItem,
	error: ExtensionError,
});
export const ExtensionRemoveRpc = Rpc.make("extension.remove", {
	payload: Schema.Struct({ id: ExtensionId, deleteData: Schema.Boolean }),
	success: Schema.Void,
	error: ExtensionError,
});
export const ExtensionUpdateRpc = Rpc.make("extension.update", {
	payload: Schema.Struct({
		id: ExtensionId,
		grantedCapabilities: Schema.Array(ExtensionCapability),
	}),
	success: ExtensionListItem,
	error: ExtensionError,
});

export const ExtensionLogsRpc = Rpc.make("extension.logs", {
	payload: ExtensionIdPayload,
	success: Schema.Array(ExtensionLogEntry),
	error: ExtensionError,
});

export const ExtensionCancelRpc = Rpc.make("extension.cancel", {
	payload: Schema.Struct({ id: ExtensionId, requestId: Schema.String }),
	success: Schema.Void,
	error: ExtensionError,
});

export const ExtensionInvokeRpc = Rpc.make("extension.invoke", {
	payload: Schema.Struct({
		id: ExtensionId,
		method: Schema.String,
		requestId: Schema.optional(Schema.String),
		input: Schema.Unknown,
		workspace: Schema.optional(
			Schema.Struct({
				projectId: FolderId,
				worktreeId: Schema.NullOr(WorktreeId),
				sessionId: Schema.NullOr(AgentSessionId),
			}),
		),
	}),
	success: Schema.Unknown,
	error: ExtensionError,
});

export const ExtensionMarketplaceListRpc = Rpc.make(
	"extension.marketplace.list",
	{
		success: Schema.Array(MarketplaceExtension),
		error: ExtensionError,
	},
);

export const ExtensionMarketplaceRefreshRpc = Rpc.make(
	"extension.marketplace.refresh",
	{
		success: Schema.Array(MarketplaceExtension),
		error: ExtensionError,
	},
);
