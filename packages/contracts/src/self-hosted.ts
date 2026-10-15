import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

import { EnvironmentId } from "./ids.ts";
import { SshEnvironmentTarget } from "./ssh.ts";

export const SelfHostedSetupPhase = Schema.Literals([
	"connecting",
	"preflight",
	"installing",
	"authorizing",
	"starting",
	"verifying",
	"ready",
	"failed",
	"cancelled",
]);
export type SelfHostedSetupPhase = typeof SelfHostedSetupPhase.Type;

export class SelfHostedPreflight extends Schema.Class<SelfHostedPreflight>(
	"SelfHostedPreflight",
)({
	osId: Schema.String,
	osVersion: Schema.String,
	architecture: Schema.Literals(["x86_64", "arm64"]),
	homeDirectory: Schema.String,
	availableDiskBytes: Schema.Number,
	nodeVersion: Schema.NullOr(Schema.String),
	gitVersion: Schema.NullOr(Schema.String),
	systemdUserAvailable: Schema.Boolean,
	lingerEnabled: Schema.Boolean,
	passwordlessSudo: Schema.Boolean,
	supported: Schema.Boolean,
	blockingReason: Schema.NullOr(Schema.String),
	manualCommand: Schema.NullOr(Schema.String),
}) {}

export class SelfHostedSetupRequest extends Schema.Class<SelfHostedSetupRequest>(
	"SelfHostedSetupRequest",
)({
	operationId: Schema.String,
	target: SshEnvironmentTarget,
	label: Schema.String,
}) {}

export class SelfHostedSetupEvent extends Schema.Class<SelfHostedSetupEvent>(
	"SelfHostedSetupEvent",
)({
	version: Schema.Literal(1),
	operationId: Schema.String,
	phase: SelfHostedSetupPhase,
	message: Schema.String,
	preflight: Schema.optional(SelfHostedPreflight),
	userCode: Schema.optional(Schema.String),
	verificationUri: Schema.optional(Schema.String),
	environmentId: Schema.optional(EnvironmentId),
	profileId: Schema.optional(Schema.String),
	errorCode: Schema.optional(Schema.String),
	occurredAt: Schema.Number,
}) {}

export class SelfHostedSetupOperation extends Schema.Class<SelfHostedSetupOperation>(
	"SelfHostedSetupOperation",
)({
	operationId: Schema.String,
	phase: SelfHostedSetupPhase,
	startedAt: Schema.Number,
}) {}

export class SelfHostedHostHealth extends Schema.Class<SelfHostedHostHealth>(
	"SelfHostedHostHealth",
)({
	osId: Schema.String,
	osVersion: Schema.String,
	architecture: Schema.String,
	cpuCores: Schema.Number,
	memoryTotalBytes: Schema.Number,
	memoryAvailableBytes: Schema.Number,
	diskTotalBytes: Schema.Number,
	diskAvailableBytes: Schema.Number,
	nodeVersion: Schema.NullOr(Schema.String),
	gitVersion: Schema.NullOr(Schema.String),
	githubCliVersion: Schema.NullOr(Schema.String),
	zuseVersion: Schema.String,
	serviceState: Schema.Literals(["running", "stopped", "failed", "unknown"]),
	apiLinked: Schema.Boolean,
	apiHeartbeatActive: Schema.Boolean,
	sampledAt: Schema.Number,
}) {}

export class SelfHostedHostError extends Schema.TaggedErrorClass<SelfHostedHostError>()(
	"SelfHostedHostError",
	{ reason: Schema.Literals(["unavailable", "not-self-hosted"]) },
) {}

export const SelfHostedHostStatusRpc = Rpc.make("host.status", {
	payload: Schema.Void,
	success: SelfHostedHostHealth,
	error: SelfHostedHostError,
});

export const SelfHostedHostDetachRpc = Rpc.make("host.detach", {
	payload: Schema.Void,
	success: Schema.Void,
	error: SelfHostedHostError,
});

export class SelfHostedRuntimeActionResult extends Schema.Class<SelfHostedRuntimeActionResult>(
	"SelfHostedRuntimeActionResult",
)({
	action: Schema.Literals(["restart", "update"]),
	accepted: Schema.Boolean,
	requestedAt: Schema.Number,
}) {}

export const SelfHostedRuntimeRestartRpc = Rpc.make("host.runtime.restart", {
	payload: Schema.Struct({ force: Schema.Boolean }),
	success: SelfHostedRuntimeActionResult,
	error: SelfHostedHostError,
});

export const SelfHostedRuntimeUpdateRpc = Rpc.make("host.runtime.update", {
	payload: Schema.Struct({ force: Schema.Boolean }),
	success: SelfHostedRuntimeActionResult,
	error: SelfHostedHostError,
});

export class SelfHostedDiagnosticsBundle extends Schema.Class<SelfHostedDiagnosticsBundle>(
	"SelfHostedDiagnosticsBundle",
)({
	fileName: Schema.String,
	content: Schema.String,
}) {}

export const SelfHostedDiagnosticsRpc = Rpc.make("host.diagnostics", {
	payload: Schema.Void,
	success: SelfHostedDiagnosticsBundle,
	error: SelfHostedHostError,
});

export class SelfHostedGithubLoginState extends Schema.Class<SelfHostedGithubLoginState>(
	"SelfHostedGithubLoginState",
)({
	operationId: Schema.optional(Schema.String),
	state: Schema.Literals([
		"disconnected",
		"authorizing",
		"connected",
		"error",
		"cancelled",
	]),
	verificationUrl: Schema.optional(Schema.String),
	verificationCode: Schema.optional(Schema.String),
	errorCode: Schema.optional(Schema.String),
}) {}

export const SelfHostedGithubStatusRpc = Rpc.make("host.github.status", {
	payload: Schema.Void,
	success: SelfHostedGithubLoginState,
	error: SelfHostedHostError,
});

export const SelfHostedGithubLoginStartRpc = Rpc.make(
	"host.github.loginStart",
	{
		payload: Schema.Void,
		success: SelfHostedGithubLoginState,
		error: SelfHostedHostError,
	},
);

export const SelfHostedGithubLoginPollRpc = Rpc.make("host.github.loginPoll", {
	payload: Schema.Struct({ operationId: Schema.String }),
	success: SelfHostedGithubLoginState,
	error: SelfHostedHostError,
});

export const SelfHostedGithubLoginCancelRpc = Rpc.make(
	"host.github.loginCancel",
	{
		payload: Schema.Struct({ operationId: Schema.String }),
		success: SelfHostedGithubLoginState,
		error: SelfHostedHostError,
	},
);

export const SelfHostedGithubLogoutRpc = Rpc.make("host.github.logout", {
	payload: Schema.Void,
	success: SelfHostedGithubLoginState,
	error: SelfHostedHostError,
});

export class SelfHostedServer extends Schema.Class<SelfHostedServer>(
	"SelfHostedServer",
)({
	environmentId: EnvironmentId,
	profileId: Schema.NullOr(Schema.String),
	label: Schema.String,
	target: Schema.NullOr(SshEnvironmentTarget),
	connectionState: Schema.Literals([
		"connected",
		"connecting",
		"offline",
		"error",
	]),
	accountLinked: Schema.Boolean,
	lastHeartbeat: Schema.NullOr(Schema.Number),
	lastError: Schema.NullOr(Schema.String),
}) {}

export const SelfHostedCliEvent = Schema.Union([
	Schema.Struct({
		version: Schema.Literal(1),
		type: Schema.Literal("phase"),
		phase: Schema.Literals(["installing", "starting", "verifying"]),
		message: Schema.String,
	}),
	Schema.Struct({
		version: Schema.Literal(1),
		type: Schema.Literal("authorization_required"),
		userCode: Schema.String,
		verificationUri: Schema.String,
	}),
	Schema.Struct({
		version: Schema.Literal(1),
		type: Schema.Literal("ready"),
		environmentId: EnvironmentId,
	}),
]);
export type SelfHostedCliEvent = typeof SelfHostedCliEvent.Type;
