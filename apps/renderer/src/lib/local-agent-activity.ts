import type { SyncPhase } from "@zuse/client-runtime/resource-state";
import type { Session } from "@zuse/contracts";

/** Cached transcripts describe history, not currently running local processes. */
export const countLocalActiveAgents = (input: {
	readonly connection: string;
	readonly sync: SyncPhase;
	readonly sessions: readonly Pick<Session, "id" | "chatId" | "status">[];
	readonly cloudChatIds: ReadonlySet<string>;
}): number | null => {
	if (input.connection !== "connected" || input.sync !== "live") return null;
	const active = new Set<string>();
	for (const session of input.sessions) {
		if (session.chatId !== null && input.cloudChatIds.has(session.chatId))
			continue;
		if (session.status === "running" || session.status === "booting")
			active.add(session.id);
	}
	return active.size;
};
