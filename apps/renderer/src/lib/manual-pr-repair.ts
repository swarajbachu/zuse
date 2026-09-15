import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import { resourceRefKey } from "@zuse/client-runtime/resource-ref";
import { CommandId, type ComposerInput, MessageId } from "@zuse/contracts";
import { pendingSessionMessages } from "./pending-session-messages.ts";
import { sendSessionMessage } from "./session-actions.ts";

const retries = new Map<
	string,
	{ messageId: MessageId; input: ComposerInput }
>();

/** Only the retained repair command may pass the manual retry guard. */
export function pendingManualRepairCommand(
	ref: SessionRef,
	repairKey: string,
): CommandId | null {
	const retry = retries.get(JSON.stringify([resourceRefKey(ref), repairKey]));
	return retry ? CommandId.make(`message-send:${retry.messageId}`) : null;
}

/** An unconfirmed send keeps its original payload and command identity. */
export async function sendManualPrRepair(
	ref: SessionRef,
	repairKey: string,
	input: ComposerInput,
): Promise<boolean> {
	const key = JSON.stringify([resourceRefKey(ref), repairKey]);
	const pending = retries.get(key) ?? {
		messageId: MessageId.make(crypto.randomUUID()),
		input,
	};
	retries.set(key, pending);
	let accepted = false;
	try {
		accepted = await sendSessionMessage(ref, pending.input, {
			messageId: pending.messageId,
		});
		return accepted;
	} finally {
		if (
			accepted ||
			!pendingSessionMessages(ref).some(
				(message) => message.id === pending.messageId,
			)
		)
			retries.delete(key);
	}
}
