import type { ClientCommand } from "./client-persistence.ts";

const stringField = (value: unknown, key: string): string | null => {
	if (typeof value !== "object" || value === null) return null;
	const field = Reflect.get(value, key);
	return typeof field === "string" ? field : null;
};

/**
 * Extracts the stable domain identity affected by an interaction command.
 * The command payload remains authoritative so persisted commands from older
 * clients recover the same overlay identity after restart.
 */
export const clientCommandTargetId = (
	command: Pick<ClientCommand, "kind" | "payload">,
): string | null => {
	switch (command.kind) {
		case "session.answerQuestion":
		case "session.cancelQuestion":
			return stringField(command.payload, "itemId");
		case "permission.decide":
			return stringField(command.payload, "requestId");
		default:
			return null;
	}
};
