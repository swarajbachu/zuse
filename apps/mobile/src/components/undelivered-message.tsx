import { useAtomValue } from "@effect/atom-react";
import { type Message, MessageId, type SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import {
	dismissFailedSessionCommand,
	makeTextInput,
	sendMessage,
} from "~/rpc/actions";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";
import {
	addOptimisticMessage,
	removeOptimisticMessage,
	sessionDeliveryAtom,
} from "~/store/messages";
import { sessionModelOptionsAtom } from "~/store/session-model-options";

/** Cloud sends carry a `message-send:` prefix; local sends use the id itself. */
const messageIdOf = (commandId: string): string =>
	commandId.startsWith("message-send:")
		? commandId.slice("message-send:".length)
		: commandId;

/** Rebuild the original send: text, attachments, references and goal mode. */
const inputOf = (message: Message) => {
	const content = message.content;
	if (content._tag === "user")
		return {
			input: makeTextInput(content.text, [], content.goal),
			asGoal: content.goal,
		};
	if (content._tag === "user_rich")
		return {
			input: makeTextInput(
				content.text,
				content.attachments,
				content.goal,
				content.fileRefs,
				content.skillRefs,
			),
			asGoal: content.goal,
		};
	return null;
};

/**
 * Marks the message whose send failed, right under it, with Resend and
 * Remove — instead of a chat-level banner. Undelivered messages render last.
 */
export function UndeliveredMessage({
	stateKey,
	connection,
	sessionId,
	messages,
}: {
	stateKey: string;
	connection: WsProtocolOptions;
	sessionId: SessionId;
	messages: readonly Message[];
}) {
	const delivery = useAtomValue(sessionDeliveryAtom(stateKey));
	// The chat's current reasoning selection, as the composer would send it.
	const modelOptions = useAtomValue(sessionModelOptionsAtom(stateKey));
	const [busy, setBusy] = useState(false);
	const failed = delivery.failed.findLast(
		(command) => command.kind === "messages.send",
	);
	const message =
		failed === undefined
			? undefined
			: messages.find((row) => row.id === messageIdOf(failed.commandId));
	const original = message === undefined ? null : inputOf(message);
	if (failed === undefined || message === undefined || original === null)
		return null;

	const remove = () => {
		removeOptimisticMessage(stateKey, message.id);
		dismissFailedSessionCommand(connection, sessionId, failed.commandId);
	};
	const resend = async () => {
		setBusy(true);
		const clientMessageId = MessageId.make(crypto.randomUUID());
		remove();
		addOptimisticMessage(stateKey, {
			...message,
			id: clientMessageId,
			createdAt: new Date(),
		});
		await Effect.runPromise(
			sendMessage({
				connection,
				sessionId,
				input: original.input,
				...(original.asGoal === undefined ? {} : { asGoal: original.asGoal }),
				clientMessageId,
				modelOptions,
			}),
		).catch(() => undefined);
		setBusy(false);
	};

	return (
		<View className="flex-row items-center justify-end gap-3 px-4 pb-2">
			<Text className="font-sans text-[12px] text-danger">Not delivered</Text>
			<Pressable
				accessibilityRole="button"
				disabled={busy}
				hitSlop={8}
				onPress={() => void resend()}
			>
				<Text className="font-sans-medium text-[12px] text-accent">Resend</Text>
			</Pressable>
			<Pressable
				accessibilityRole="button"
				disabled={busy}
				hitSlop={8}
				onPress={remove}
			>
				<Text className="font-sans-medium text-[12px] text-muted-foreground">
					Remove
				</Text>
			</Pressable>
		</View>
	);
}
