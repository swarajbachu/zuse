import { Effect } from "effect";
import {
	CloudChatCipher,
	type CloudChatRecordKind,
} from "./cloud-chat-cipher.ts";
import {
	type CloudWorkspaceRecord,
	CloudWorkspaceStore,
} from "./cloud-workspace-store.ts";

const metadataFor = (workspace: CloudWorkspaceRecord) => {
	const firstMessage =
		typeof workspace.requestConfig.firstMessage === "string"
			? workspace.requestConfig.firstMessage
			: undefined;
	const configuredTitle =
		typeof workspace.requestConfig.title === "string"
			? workspace.requestConfig.title.trim()
			: "";
	const firstLine = firstMessage?.trim().split(/\r?\n/u, 1)[0]?.trim() ?? "";
	const title =
		configuredTitle.length > 0
			? configuredTitle
			: firstLine.length === 0
				? workspace.branch
				: firstLine.length > 80
					? `${firstLine.slice(0, 77)}…`
					: firstLine;
	return { title, ...(firstMessage === undefined ? {} : { firstMessage }) };
};

export const backfillCloudChatEncryption = Effect.fn(
	"backfillCloudChatEncryption",
)(function* (limit = 25) {
	const store = yield* CloudWorkspaceStore;
	const cipher = yield* CloudChatCipher;
	const workspaces = yield* store.listLegacyChatWorkspaces(limit);
	let migratedRecords = 0;
	for (const workspace of workspaces) {
		const migrate = Effect.fn("migrateCloudChatRecord")(function* (
			recordKind: CloudChatRecordKind,
			recordId: string,
			plaintext: string,
		) {
			const context = {
				accountId: workspace.accountId,
				workspaceId: workspace.workspaceId,
				recordKind,
				recordId,
				version: 1,
			} as const;
			const encrypted = yield* cipher.encrypt(context, plaintext);
			const verified = yield* cipher.decrypt(context, encrypted);
			if (verified !== plaintext)
				return yield* Effect.die("chat_backfill_verify_failed");
			return encrypted;
		});
		if (workspace.chatMetadataCiphertext === undefined) {
			const encrypted = yield* migrate(
				"workspace-metadata",
				workspace.chatId,
				JSON.stringify(metadataFor(workspace)),
			);
			yield* store.migrateWorkspaceChatMetadata(
				workspace.workspaceId,
				encrypted,
			);
			migratedRecords += 1;
		}
		for (const command of yield* store.listStoredCommands(
			workspace.workspaceId,
		)) {
			if (command.payload === undefined) continue;
			const encrypted = yield* migrate(
				"command",
				command.commandId,
				JSON.stringify(command.payload),
			);
			yield* store.migrateCommandPayload(command.commandId, encrypted);
			migratedRecords += 1;
		}
		for (const event of yield* store.listEvents(workspace.workspaceId, 0)) {
			if (event.payloadJson === undefined) continue;
			const encrypted = yield* migrate(
				"runtime-event",
				event.eventId,
				event.payloadJson,
			);
			yield* store.migrateEventPayload(
				event.workspaceId,
				event.runtimeSequence,
				encrypted,
			);
			migratedRecords += 1;
		}
	}
	return { workspaces: workspaces.length, records: migratedRecords };
});
