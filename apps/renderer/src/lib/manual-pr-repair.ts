import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import { resourceRefKey } from "@zuse/client-runtime/resource-ref";
import { type ComposerInput, MessageId } from "@zuse/contracts";
import { pendingSessionMessages } from "./pending-session-messages.ts";
import { sendSessionMessage } from "./session-actions.ts";

const retries = new Map<
	string,
	{ messageId: MessageId; input: ComposerInput }
>();

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
