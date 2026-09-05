import type { Command } from "@zuse/contracts";
import fuzzysort from "fuzzysort";
import { APPLICATION_COMMANDS } from "./commands.ts";
import { COMMAND_META, COMMANDS_IN_ORDER } from "./default-keybindings.ts";

const COMMAND_PREFIX = ">";

/** Commands that would be circular or inert when launched from quick open. */
const EXCLUDED_COMMANDS: ReadonlySet<Command> = new Set(["open-chat-switcher"]);

export interface ChatSwitcherCommandRow {
	readonly kind: "command";
	readonly command: Command;
	readonly label: string;
	readonly description: string;
	readonly group: string;
	readonly searchText: string;
}

const ALL_COMMAND_ROWS: ReadonlyArray<ChatSwitcherCommandRow> =
	COMMANDS_IN_ORDER.flatMap((command) => {
		if (!APPLICATION_COMMANDS.has(command) || EXCLUDED_COMMANDS.has(command))
			return [];
		const metadata = COMMAND_META[command];
		return [
			{
				kind: "command" as const,
				command,
				label: metadata.label,
				description: metadata.description,
				group: metadata.group,
				searchText:
					`${metadata.label} ${metadata.description} ${metadata.group}`.toLowerCase(),
			},
		];
	});

/** Returns the command query after `>`, or `null` while quick open is in chat mode. */
export function commandSearchQuery(query: string): string | null {
	const trimmedStart = query.trimStart();
	if (!trimmedStart.startsWith(COMMAND_PREFIX)) return null;
	return trimmedStart.slice(COMMAND_PREFIX.length).trim();
}

/**
 * Project safe global commands into quick-open rows. The global registry owns
 * availability and ordering; this helper owns only the `>` mode and ranking.
 */
export function commandRowsForQuery(
	query: string,
): ReadonlyArray<ChatSwitcherCommandRow> {
	const searchQuery = commandSearchQuery(query);
	if (searchQuery === null) return [];
	if (searchQuery.length === 0) return ALL_COMMAND_ROWS;
	return fuzzysort
		.go(searchQuery, ALL_COMMAND_ROWS, {
			key: "searchText",
			threshold: 0.3,
			limit: 50,
		})
		.map((result) => result.obj);
}
