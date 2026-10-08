import {
	CLOUD_TRANSCRIPT_CHECKPOINT_SCHEMA_VERSION,
	CloudAuthProvider,
	CloudTranscriptCheckpointPayload,
} from "@zuse/contracts";
import {
	cloudTranscriptAdditionalData,
	decryptCloudTranscript,
	sha256Base64Url,
} from "@zuse/utils/cloud-transcript-crypto";
import { Effect, Schema } from "effect";
import {
	getCloudTranscriptObject,
	openCloudTranscriptKey,
} from "./cloud-transcript.ts";
import { cloudWorkspaceRuntimeGeneration } from "./cloud-workspace-runtime-fence.ts";
import {
	type CloudWorkspaceApiMessageRecord,
	type CloudWorkspaceRecord,
	CloudWorkspaceStore,
} from "./cloud-workspace-store.ts";

// Older runtimes can leave a turn running after agent execution fails. Use its
// authenticated checkpoint as a diagnostic, never as a fabricated settlement.
export const readApiTurnFailure = Effect.fn("readApiTurnFailure")(function* (
	workspace: CloudWorkspaceRecord,
	submitted: CloudWorkspaceApiMessageRecord,
) {
	const agent = CloudAuthProvider.literals.find(
		(value) => value === workspace.requestConfig.agent,
	);
	if (!agent || !submitted.turnId || !workspace.wrappedTranscriptKey)
		return undefined;
	const store = yield* CloudWorkspaceStore;
	const checkpoint = yield* store.getTranscriptCheckpoint(
		workspace.workspaceId,
		workspace.initialSessionId,
	);
	if (
		!checkpoint ||
		checkpoint.runtimeGeneration !== cloudWorkspaceRuntimeGeneration(workspace)
	)
		return undefined;
	const ciphertext = yield* getCloudTranscriptObject(checkpoint.objectKey);
	if (
		!ciphertext ||
		(yield* Effect.promise(() => sha256Base64Url(ciphertext))) !==
			checkpoint.ciphertextSha256
	)
		return undefined;
	const key = yield* openCloudTranscriptKey(
		workspace.accountId,
		workspace.workspaceId,
		workspace.wrappedTranscriptKey,
	);
	const payload = yield* Effect.tryPromise(async () =>
		Schema.decodeUnknownSync(CloudTranscriptCheckpointPayload)(
			JSON.parse(
				new TextDecoder().decode(
					await decryptCloudTranscript({
						encodedKey: key,
						ciphertext,
						additionalData: cloudTranscriptAdditionalData({
							workspaceId: checkpoint.workspaceId,
							sessionId: checkpoint.sessionId,
							epoch: checkpoint.streamEpoch,
							version: checkpoint.streamVersion,
							schemaVersion: CLOUD_TRANSCRIPT_CHECKPOINT_SCHEMA_VERSION,
						}),
					}),
				),
			),
		),
	);
	if (
		payload.workspaceId !== workspace.workspaceId ||
		payload.sessionId !== workspace.initialSessionId ||
		payload.cursor.epoch !== checkpoint.streamEpoch ||
		payload.cursor.version !== checkpoint.streamVersion
	)
		return undefined;
	const projection = payload.projection;
	if (
		projection.status !== "error" ||
		(projection.currentTurn !== null &&
			projection.currentTurn.turnId !== submitted.turnId)
	)
		return undefined;
	const user = [...projection.messages]
		.reverse()
		.find((message) => message.role === "user");
	const error = projection.messages.at(-1);
	const launchMessageId =
		submitted.messageId === `msg_launch_${workspace.workspaceId}`
			? `launch:${workspace.workspaceId}:message`
			: undefined;
	if (
		(user
			? user.id !== submitted.messageId && user.id !== launchMessageId
			: projection.currentTurn?.turnId !== submitted.turnId) ||
		!error ||
		error.createdAt < new Date(submitted.createdAtMs) ||
		error.role !== "system" ||
		error.content._tag !== "error"
	)
		return undefined;
	return {
		turnId: submitted.turnId,
		agent,
		code: /^[\w -]+ CLI not found\b/u.test(error.content.message)
			? "agent_not_installed"
			: "agent_error",
		message: error.content.message.slice(0, 1200),
	};
});
