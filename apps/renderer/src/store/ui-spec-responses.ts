import { createAtomStore as create } from "../state/atom-store.ts";

type ResponseStatus = "sending" | "sent";

/**
 * Send-once state for generated UI blocks, keyed by message ID. It lives
 * outside the block because virtualized transcript rows remount on scroll;
 * a remounted block must stay locked while its response is in flight or sent.
 */
type UiSpecResponsesState = {
	readonly byMessageId: Readonly<Record<string, ResponseStatus>>;
	/** Claim the block for one send. False when it already sent or is sending. */
	readonly begin: (messageId: string) => boolean;
	/** Record the outcome; a failed send unlocks the block for another try. */
	readonly settle: (messageId: string, accepted: boolean) => void;
};

export const useUiSpecResponses = create<UiSpecResponsesState>((set, get) => ({
	byMessageId: {},
	begin: (messageId) => {
		if (get().byMessageId[messageId] !== undefined) return false;
		set({ byMessageId: { ...get().byMessageId, [messageId]: "sending" } });
		return true;
	},
	settle: (messageId, accepted) => {
		const next = { ...get().byMessageId };
		if (accepted) next[messageId] = "sent";
		else delete next[messageId];
		set({ byMessageId: next });
	},
}));
