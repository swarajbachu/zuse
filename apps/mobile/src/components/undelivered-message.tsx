import { useAtomValue } from "@effect/atom-react";
import { type Message, MessageId, type SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import {
	dismissFailedSessionCommands,
	makeTextInput,
	sendMessage,
} from "~/rpc/actions";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";
import {
	addOptimisticMessage,
	removeOptimisticMessage,
	sessionDeliveryAtom,
} from "~/store/messages";

/** Cloud sends carry a `message-send:` prefix; local sends use the id itself. */
const messageIdOf = (commandId: string): string =>
	commandId.startsWith("message-send:")
		? commandId.slice("message-send:".length)
		: commandId;

const textOf = (message: Message): string | null =>
	message.content._tag === "user" || message.content._tag === "user_rich"
		? message.content.text
		: null;

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
	const [busy, setBusy] = useState(false);
	const failed = delivery.failed.findLast(
		(command) => command.kind === "messages.send",
	);
	const message =
		failed === undefined
			? undefined
			: messages.find((row) => row.id === messageIdOf(failed.commandId));
	const text = message === undefined ? null : textOf(message);
	if (failed === undefined || message === undefined || text === null)
		return null;

	const remove = () => {
		removeOptimisticMessage(stateKey, message.id);
		dismissFailedSessionCommands(connection, sessionId);
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
				input: makeTextInput(text),
				clientMessageId,
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
