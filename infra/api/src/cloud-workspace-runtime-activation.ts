import {
	type SandboxProcessInput,
	type SandboxProviderAdapter,
	SandboxProviderError,
} from "@zuse/sandbox-providers";
import { Effect, Option, Schema } from "effect";
import { openApiString, sealApiString } from "./api-sealing.ts";
import type { CloudWorkspaceRecord } from "./cloud-workspace-store.ts";

export const RUNTIME_ACTIVATION_JOURNAL =
	"/var/lib/zuse/runtime-update/transaction.json";
export const RUNTIME_ACTIVATION_INSTALLER =
	"/var/lib/zuse/project-build/runtime-updater.mjs";
export const RUNTIME_ACTIVATION_RETRY_MS = 5_000;
export const RUNTIME_ACTIVATION_TIMEOUT_MS = 120_000;
export const RUNTIME_PREPARATION_TIMEOUT_MS = 10 * 60_000;

const Activation = Schema.Struct({
	id: Schema.String,
	bootstrap: Schema.optionalKey(Schema.Boolean),
	mode: Schema.optionalKey(
		Schema.Literals(["restart-installed", "change-release"]),
	),
	phase: Schema.Literals([
		"preparing",
		"launching",
		"confirming",
		"rolling-back",
		"confirmed",
		"failed",
		"verification-needed",
	]),
	startedAtMs: Schema.Number,
	attempts: Schema.Number,
	generation: Schema.optionalKey(Schema.Number),
	targetVersion: Schema.optionalKey(Schema.String),
	sealedBootToken: Schema.optionalKey(Schema.String),
	lastErrorCode: Schema.optionalKey(Schema.String),
});
export type RuntimeActivation = typeof Activation.Type;

const Journal = Schema.Struct({
	transactionId: Schema.String,
	phase: Schema.String,
	generation: Schema.NullOr(Schema.Number),
	confirmedVersion: Schema.optionalKey(Schema.NullOr(Schema.String)),
	candidate: Schema.Struct({ version: Schema.String }),
	previous: Schema.NullOr(
		Schema.Struct({
			version: Schema.NullOr(Schema.String),
			signed: Schema.Boolean,
		}),
	),
});
export type RuntimeActivationJournal = typeof Journal.Type;

export const runtimeActivation = (
	workspace: CloudWorkspaceRecord,
): RuntimeActivation | null =>
	Option.getOrNull(
		Schema.decodeUnknownOption(Activation)(
			workspace.requestConfig.runtimeActivation,
		),
	);

export const readRuntimeActivationJournal = Effect.fn(
	"readRuntimeActivationJournal",
)(function* (
	provider: SandboxProviderAdapter,
	workspace: CloudWorkspaceRecord,
) {
	if (workspace.providerSandboxId === undefined) return null;
	const text = yield* provider
		.readTextFile(workspace.providerSandboxId, RUNTIME_ACTIVATION_JOURNAL)
		.pipe(
			Effect.timeout("10 seconds"),
			Effect.catchTag("TimeoutError", () =>
				Effect.fail(
					new SandboxProviderError({
						code: "transient",
						diagnostic: "runtime update journal read timed out",
					}),
				),
			),
			Effect.catchTag("SandboxProviderError", (error) =>
				error.code === "not-found" ? Effect.succeed("") : Effect.fail(error),
			),
		);
	try {
		return Option.getOrNull(
			Schema.decodeUnknownOption(Journal)(JSON.parse(text)),
		);
	} catch {
		return null;
	}
});

const bootContext = (
	workspace: CloudWorkspaceRecord,
	operation: RuntimeActivation,
) =>
	`runtime-activation\n${workspace.accountId}\n${workspace.workspaceId}\n${operation.id}\n${operation.generation}`;

export const sealRuntimeActivationBoot = (
	workspace: CloudWorkspaceRecord,
	operation: RuntimeActivation,
	token: string,
) => sealApiString(bootContext(workspace, operation), token);

export const openRuntimeActivationBoot = (
	workspace: CloudWorkspaceRecord,
	operation: RuntimeActivation,
) =>
	openApiString(
		bootContext(workspace, operation),
		operation.sealedBootToken ?? "",
	);

/** A launch retry replays exactly one authorized operation; socket retries never enter here. */
export const activationProcessInput = (
	input: SandboxProcessInput,
	operation: RuntimeActivation,
	mode: "activate" | "rollback" = "activate",
): SandboxProcessInput => ({
	...input,
	activation: {
		operationId: operation.id,
		generation: operation.generation ?? 0,
	},
	env: {
		...input.env,
		...(operation.mode === "restart-installed"
			? {}
			: {
					ZUSE_RUNTIME_UPDATE_TRANSACTION_ID: operation.id,
					ZUSE_RUNTIME_UPDATE_GENERATION: String(operation.generation),
					ZUSE_RUNTIME_EXPECTED_VERSION: operation.targetVersion ?? "",
					ZUSE_RUNTIME_ACTIVATION_MODE: mode,
					ZUSE_RUNTIME_ACTIVATION_INSTALLER: RUNTIME_ACTIVATION_INSTALLER,
				}),
		ZUSE_RUNTIME_SKIP_TOOLCHAIN: "1",
	},
});

/** Backoff is durable and capped; a timeout never silently changes the owning generation. */
export const runtimeActivationRetryAt = (
	operation: RuntimeActivation,
	nowMs: number,
) =>
	Math.min(
		nowMs +
			Math.min(
				60_000,
				RUNTIME_ACTIVATION_RETRY_MS * 2 ** Math.min(operation.attempts, 4),
			),
		operation.startedAtMs +
			(operation.phase === "preparing"
				? RUNTIME_PREPARATION_TIMEOUT_MS
				: RUNTIME_ACTIVATION_TIMEOUT_MS),
	);
