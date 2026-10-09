import { isHtmlRenderTool } from "@zuse/client-runtime/html-render";
import {
	isUserMessage,
	normalizeTimelineMessages,
} from "@zuse/client-runtime/timeline";
import type { Message } from "@zuse/contracts";
import {
	type DelegationMember,
	delegationItemIds,
	groupDelegations,
	isDelegationMessage,
} from "./delegation-display.ts";
import { groupMessages } from "./group-messages.ts";
import { normalizeToolCallEnvelope } from "./tool-call-envelope.ts";

export type ChatTimelineRow =
	| {
			readonly kind: "tool-activity";
			readonly id: string;
			readonly messages: readonly Message[];
	  }
	| {
			readonly kind: "message";
			readonly id: string;
			readonly message: Message;
			readonly enterUser: boolean;
			readonly showAssistantCommands: boolean;
	  }
	| {
			readonly kind: "delegation";
			readonly id: string;
			readonly members: ReadonlyArray<DelegationMember>;
	  }
	| {
			readonly kind: "turn-summary";
			readonly id: string;
			readonly body: ReadonlyArray<Message>;
			readonly showAssistantCommands: boolean;
	  }
	| {
			readonly kind: "working";
			readonly id: string;
			readonly messages: ReadonlyArray<Message>;
	  };

export { isUserMessage };

export interface ChatTurnNavigationEntry {
	readonly messageId: string;
	readonly rowIndex: number;
	readonly turnNumber: number;
	readonly text: string;
}

export function deriveChatTurnNavigationEntries(
	rows: ReadonlyArray<ChatTimelineRow>,
): ChatTurnNavigationEntry[] {
	const entries: ChatTurnNavigationEntry[] = [];
	for (const [rowIndex, row] of rows.entries()) {
		if (row.kind !== "message") continue;
		if (!isUserMessage(row.message)) continue;
		entries.push({
			messageId: row.message.id,
			rowIndex,
			turnNumber: entries.length + 1,
			text: row.message.content.text.trim() || "Untitled turn",
		});
	}
	return entries;
}

export function deriveChatTurnRailEntries(
	turns: ReadonlyArray<ChatTurnNavigationEntry>,
	maxTicks = 18,
	activeMessageId?: string | null,
): ChatTurnNavigationEntry[] {
	if (maxTicks <= 0 || turns.length === 0) return [];
	if (turns.length <= maxTicks) return [...turns];
	const activeIndex =
		activeMessageId === null || activeMessageId === undefined
			? -1
			: turns.findIndex((turn) => turn.messageId === activeMessageId);
	if (maxTicks === 1) {
		return [turns[Math.max(0, activeIndex)]].filter(
			(turn): turn is ChatTurnNavigationEntry => turn !== undefined,
		);
	}
	const lastIndex = turns.length - 1;
	const sampledIndices = Array.from({ length: maxTicks }, (_, tickIndex) =>
		Math.round((tickIndex * lastIndex) / (maxTicks - 1)),
	);
	if (
		sampledIndices.length > 2 &&
		activeIndex > 0 &&
		activeIndex < lastIndex &&
		!sampledIndices.includes(activeIndex)
	) {
		let replacement = 1;
		for (let index = 2; index < sampledIndices.length - 1; index += 1) {
			if (
				Math.abs((sampledIndices[index] ?? 0) - activeIndex) <
				Math.abs((sampledIndices[replacement] ?? 0) - activeIndex)
			) {
				replacement = index;
			}
		}
		sampledIndices[replacement] = activeIndex;
		sampledIndices.sort((left, right) => left - right);
	}
	return sampledIndices
		.map((index) => turns[index])
		.filter((turn): turn is ChatTurnNavigationEntry => turn !== undefined);
}

export function resolveLatestUserMessageId(
	rows: ReadonlyArray<ChatTimelineRow>,
): string | null {
	for (let index = rows.length - 1; index >= 0; index -= 1) {
		const row = rows[index];
		if (row?.kind === "message" && isUserMessage(row.message)) {
			return row.message.id;
		}
	}
	return null;
}

export function rowAnchorMessageId(row: ChatTimelineRow): string | null {
	return row.kind === "message" && isUserMessage(row.message)
		? row.message.id
		: null;
}

export { normalizeTimelineMessages };

export const isForkableAssistantMessage = (message: Message): boolean =>
	message.content._tag === "assistant" &&
	message.content.text.trim().length > 0 &&
	(!("parentItemId" in message.content) ||
		message.content.parentItemId === undefined);

/** Rows drawn as branches of a tool tree, with the connector on the left. */
export const isVisualMessage = (message: Message): boolean =>
	message.content._tag === "tool_use" &&
	isHtmlRenderTool(
		normalizeToolCallEnvelope(
			message.content.tool,
			message.content.input,
			undefined,
		).tool,
	);

export const isToolTreeBranch = (message: Message): boolean =>
	message.content._tag === "tool_use" || message.content._tag === "thinking";

/** The reply that closes a turn — the only one that carries copy and fork. */
export const findFinalAssistantMessage = (
	body: ReadonlyArray<Message>,
): Message | null => body.findLast(isForkableAssistantMessage) ?? null;

/** Build turn rows, exposing reply commands only on each settled turn's final reply. */
export function deriveChatTimelineRows({
	messages,
	inFlight,
	awaitingPlanApproval,
}: {
	readonly messages: ReadonlyArray<Message>;
	readonly inFlight: boolean;
	readonly awaitingPlanApproval: boolean;
}): ChatTimelineRow[] {
	const normalizedMessages = normalizeTimelineMessages(messages);
	const turns: Array<{
		user: Message | null;
		body: Message[];
	}> = [];
	let current: { user: Message | null; body: Message[] } | null = null;

	for (const message of normalizedMessages) {
		if (isUserMessage(message)) {
			if (current !== null) turns.push(current);
			current = { user: message, body: [] };
		} else {
			if (current === null) current = { user: null, body: [] };
			current.body.push(message);
		}
	}
	if (current !== null) turns.push(current);

	const rows: ChatTimelineRow[] = [];

	for (const [index, turn] of turns.entries()) {
		const isLastTurn = index === turns.length - 1;
		const isLive = inFlight && isLastTurn;
		// Copy and fork appear once the turn settles, on its final reply only.
		const finalAssistant = isLive ? null : findFinalAssistantMessage(turn.body);
		const showAssistantCommands = (message: Message): boolean =>
			message === finalAssistant;

		if (turn.user !== null) {
			rows.push({
				kind: "message",
				id: `message:${turn.user.id}`,
				message: turn.user,
				enterUser: true,
				showAssistantCommands: false,
			});
		}

		const bodyGroups = groupDelegations(groupMessages(turn.body));
		// Delegated work stays visible after the turn settles, like plans.
		const delegations = bodyGroups.filter(
			(group) => group.kind === "delegation",
		);
		const delegatedItemIds = delegationItemIds(
			delegations.flatMap((group) => group.members),
		);
		const undelegatedBody =
			delegatedItemIds.size === 0
				? turn.body
				: turn.body.filter(
						(message) => !isDelegationMessage(message, delegatedItemIds),
					);
		const hasToolCalls = undelegatedBody.some(
			(message) => message.content._tag === "tool_use",
		);
		const hasFinalText = undelegatedBody.some(
			(message) =>
				message.content._tag === "assistant" &&
				message.content.text.trim().length > 0,
		);
		const showSummary =
			!isLive &&
			hasToolCalls &&
			hasFinalText &&
			!turn.body.some(isVisualMessage);
		const planMessages = turn.body.filter(
			(message) =>
				message.content._tag === "tool_use" &&
				message.content.tool === "ExitPlanMode",
		);
		const planItemIds = new Set(
			planMessages.flatMap((message) =>
				message.content._tag === "tool_use" ? [message.content.itemId] : [],
			),
		);
		const summaryBody =
			planMessages.length === 0
				? undelegatedBody
				: undelegatedBody.filter((message) => {
						if (
							message.content._tag === "tool_use" &&
							message.content.tool === "ExitPlanMode"
						) {
							return false;
						}
						if (
							message.content._tag === "tool_result" &&
							planItemIds.has(message.content.itemId)
						) {
							return false;
						}
						return true;
					});

		if (showSummary) {
			for (const message of planMessages) {
				rows.push({
					kind: "message",
					id: `message:${message.id}`,
					message,
					enterUser: false,
					showAssistantCommands: showAssistantCommands(message),
				});
			}
			for (const group of delegations) {
				rows.push({ kind: "delegation", id: group.id, members: group.members });
			}
			rows.push({
				kind: "turn-summary",
				id: `summary:${turn.user?.id ?? `turn-${index}`}`,
				body: summaryBody,
				showAssistantCommands: finalAssistant !== null,
			});
			continue;
		}

		for (const group of bodyGroups) {
			if (group.kind === "single") {
				rows.push({
					kind: "message",
					id: `message:${group.message.id}`,
					message: group.message,
					enterUser: false,
					showAssistantCommands: showAssistantCommands(group.message),
				});
			} else {
				rows.push({ kind: "delegation", id: group.id, members: group.members });
			}
		}
	}

	if (inFlight && !awaitingPlanApproval) {
		rows.push({
			kind: "working",
			id: "working",
			messages,
		});
	}

	return groupToolActivityRows(rows);
}

/** Cloud history pages preserve message references; only changed turns regroup. */
export const createCloudTimelineRows = () => {
	let cache = new Map<
		string,
		{ messages: readonly Message[]; live: boolean; rows: ChatTimelineRow[] }
	>();
	return (
		input: Parameters<typeof deriveChatTimelineRows>[0],
	): ChatTimelineRow[] => {
		const turns: Message[][] = [];
		for (const message of normalizeTimelineMessages(input.messages)) {
			if (isUserMessage(message) || turns.length === 0) turns.push([]);
			turns[turns.length - 1]?.push(message);
		}
		const next = new Map<
			string,
			{ messages: readonly Message[]; live: boolean; rows: ChatTimelineRow[] }
		>();
		const rows: ChatTimelineRow[] = [];
		for (const [index, messages] of turns.entries()) {
			const key = messages[0]?.id ?? String(index);
			const live = input.inFlight && index === turns.length - 1;
			const previous = cache.get(key);
			const entry =
				previous &&
				previous.live === live &&
				previous.messages.length === messages.length &&
				messages.every((message, i) => message === previous.messages[i])
					? previous
					: {
							messages,
							live,
							rows: deriveChatTimelineRows({
								messages,
								inFlight: live,
								awaitingPlanApproval: true,
							}),
						};
			next.set(key, entry);
			rows.push(...entry.rows);
		}
		cache = next;
		if (input.inFlight && !input.awaitingPlanApproval)
			rows.push({ kind: "working", id: "working", messages: input.messages });
		return rows;
	};
};

/** Invisible status updates must not split the tools between actual messages. */
export function groupToolActivityRows(
	rows: readonly ChatTimelineRow[],
): ChatTimelineRow[] {
	const output: ChatTimelineRow[] = [];
	let active:
		| { kind: "tool-activity"; id: string; messages: Message[] }
		| undefined;
	// Thinking only joins a tree when a tool follows it; until then it is held
	// here so thinking that leads straight into text stays a standalone row.
	let leading: Extract<ChatTimelineRow, { kind: "message" }>[] = [];
	for (const row of rows) {
		const tag = row.kind === "message" ? row.message.content._tag : undefined;
		const joinsActivity =
			row.kind === "message" &&
			(tag === "tool_result" ||
				tag === "thinking" ||
				tag === "usage" ||
				tag === "context_usage" ||
				tag === "usage_limit" ||
				tag === "subagent_progress" ||
				(row.message.content._tag === "assistant" &&
					row.message.content.text.trim().length === 0));
		if (
			row.kind === "message" &&
			!isVisualMessage(row.message) &&
			(tag === "tool_use" || (active !== undefined && joinsActivity))
		) {
			if (active === undefined) {
				active = {
					kind: "tool-activity",
					id: `tools:${(leading[0] ?? row).id}`,
					messages: leading.map((held) => held.message),
				};
				leading = [];
				output.push(active);
			}
			active.messages.push(row.message);
			continue;
		}
		if (
			row.kind === "message" &&
			active === undefined &&
			(tag === "thinking" || (leading.length > 0 && joinsActivity))
		) {
			leading.push(row);
			continue;
		}
		active = undefined;
		output.push(...leading, row);
		leading = [];
	}
	output.push(...leading);
	return output;
}
