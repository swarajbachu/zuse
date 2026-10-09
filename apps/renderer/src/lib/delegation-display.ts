import {
	isSessionRuntimeBusy,
	type SessionRuntimeState,
} from "@zuse/client-runtime/session-presentation";
import {
	type AgentItemId,
	type Message,
	ProviderId,
	type SessionStatus,
} from "@zuse/contracts";
import { Schema } from "effect";
import type { RenderGroup } from "./group-messages.ts";
import {
	orchestrationToolName,
	parseOrchestrationResult,
} from "./orchestration-tools.ts";
import {
	normalizeToolCallEnvelope,
	type ToolCallResult,
} from "./tool-call-envelope.ts";

/**
 * Delegated work — native subagents (Agent/Task) and zuse-orchestration
 * spawns (create_thread/create_chat/create_session) — drawn as one kind of
 * row. Adjacent delegations group under one header: avatar stack, count,
 * "2 working · 1 done", and one elapsed span.
 */
export type DelegationStatus = "working" | "done" | "failed" | "stopped";

export type SubagentRenderGroup = Extract<RenderGroup, { kind: "subagent" }>;

export type DelegationMember =
	| {
			readonly kind: "subagent";
			readonly id: string;
			readonly group: SubagentRenderGroup;
	  }
	| {
			readonly kind: "spawn";
			readonly id: string;
			readonly itemId: AgentItemId;
			readonly input: unknown;
			readonly createdAt: Date;
			readonly result: ToolCallResult | null;
	  };

export type DelegationOpenTarget =
	| {
			readonly kind: "chat";
			readonly chatId: string;
			readonly sessionId: string;
	  }
	| { readonly kind: "subagent"; readonly childSessionId: string };

export interface DelegationView {
	readonly id: string;
	readonly title: string;
	readonly providerId: ProviderId | null;
	readonly status: DelegationStatus;
	/** One line: live progress while working, the result once settled. */
	readonly detail: string | null;
	readonly startedAt: number | null;
	readonly completedAt: number | null;
	readonly open: DelegationOpenTarget | null;
}

const SPAWN_TOOLS = new Set(["create_thread", "create_chat", "create_session"]);

const isProviderId = Schema.is(ProviderId);

/**
 * An orchestration call that spawns a chat or session, as a delegation.
 * It joins the fleet while pending or once it reports a chat; follow-ups,
 * failures, and unparseable results stay ordinary tool rows so errors show.
 */
export const spawnDelegationMember = (
	id: string,
	content: Extract<Message["content"], { _tag: "tool_use" }>,
	createdAt: Date,
	rawResult: ToolCallResult | undefined,
): Extract<DelegationMember, { kind: "spawn" }> | null => {
	const normalized = normalizeToolCallEnvelope(
		content.tool,
		content.input,
		rawResult,
	);
	const name = orchestrationToolName(normalized.tool);
	if (name === null || !SPAWN_TOOLS.has(name)) return null;
	const result = normalized.result ?? null;
	if (
		result !== null &&
		(result.isError ||
			typeof parseOrchestrationResult(result.output)?.chatId !== "string")
	) {
		return null;
	}
	return {
		kind: "spawn",
		id,
		itemId: content.itemId,
		input: normalized.input,
		createdAt,
		result,
	};
};

const INVISIBLE_TAGS = new Set<Message["content"]["_tag"]>([
	"usage",
	"context_usage",
	"usage_limit",
	"subagent_progress",
]);

/** Rows that render nothing, so they never split a fleet of delegations. */
const isInvisibleMessage = (message: Message): boolean =>
	INVISIBLE_TAGS.has(message.content._tag) ||
	(message.content._tag === "assistant" &&
		message.content.text.trim().length === 0);

export type DelegationRenderGroup =
	| Extract<RenderGroup, { kind: "single" }>
	| {
			readonly kind: "delegation";
			readonly id: string;
			readonly members: ReadonlyArray<DelegationMember>;
	  };

/**
 * Fold subagent groups and orchestration spawns into delegation groups.
 * Spawn results are absorbed by their member; adjacent delegations merge
 * across rows that render nothing.
 */
export function groupDelegations(
	groups: ReadonlyArray<RenderGroup>,
): DelegationRenderGroup[] {
	const resultsByItemId = new Map<AgentItemId, ToolCallResult>();
	for (const group of groups) {
		const content = group.kind === "single" ? group.message.content : null;
		if (content?._tag === "tool_result") {
			resultsByItemId.set(content.itemId, {
				output: content.output,
				isError: content.isError,
			});
		}
	}
	const spawns = new Map<AgentItemId, DelegationMember>();
	for (const group of groups) {
		if (group.kind !== "single") continue;
		const content = group.message.content;
		if (content._tag !== "tool_use") continue;
		const member = spawnDelegationMember(
			group.message.id,
			content,
			group.message.createdAt,
			resultsByItemId.get(content.itemId),
		);
		if (member !== null) spawns.set(content.itemId, member);
	}

	const out: DelegationRenderGroup[] = [];
	let open: { id: string; members: DelegationMember[] } | null = null;
	let held: Extract<RenderGroup, { kind: "single" }>[] = [];
	const flush = () => {
		if (open !== null) {
			out.push({ kind: "delegation", id: open.id, members: open.members });
			open = null;
		}
		out.push(...held);
		held = [];
	};
	const add = (member: DelegationMember) => {
		if (open === null) {
			out.push(...held);
			held = [];
			open = { id: `delegation:${member.id}`, members: [member] };
			return;
		}
		open.members.push(member);
	};

	for (const group of groups) {
		if (group.kind === "subagent") {
			add({ kind: "subagent", id: group.parent.id, group });
			continue;
		}
		const content = group.message.content;
		if (content._tag === "tool_result" && spawns.has(content.itemId)) {
			continue;
		}
		const spawn =
			content._tag === "tool_use" ? spawns.get(content.itemId) : undefined;
		if (spawn !== undefined) {
			add(spawn);
			continue;
		}
		if (open !== null && isInvisibleMessage(group.message)) {
			held.push(group);
			continue;
		}
		flush();
		out.push(group);
	}
	flush();
	return out;
}

/** Item ids whose messages a delegation member owns, for filtering summaries. */
export const delegationItemIds = (
	members: ReadonlyArray<DelegationMember>,
): Set<AgentItemId> =>
	new Set(
		members.map((member) =>
			member.kind === "subagent" ? member.group.parentItemId : member.itemId,
		),
	);

/** True when the message belongs to one of the given delegations. */
export const isDelegationMessage = (
	message: Message,
	itemIds: ReadonlySet<AgentItemId>,
): boolean => {
	const content = message.content;
	if (
		(content._tag === "tool_use" ||
			content._tag === "tool_result" ||
			content._tag === "subagent_summary") &&
		itemIds.has(content.itemId)
	) {
		return true;
	}
	return (
		"parentItemId" in content &&
		content.parentItemId !== undefined &&
		itemIds.has(content.parentItemId)
	);
};

/** One line of markdown: drop link targets, code ticks, and list bullets. */
export const delegationDetail = (
	text: string | null | undefined,
): string | null => {
	if (text === null || text === undefined) return null;
	const plain = text
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/`/g, "")
		.replace(/^[ \t]*(?:[-*]|#{1,6})[ \t]+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
	if (plain.length === 0) return null;
	return plain.length > 280 ? `${plain.slice(0, 280).trimEnd()}…` : plain;
};

/** "45s", "8m 30s", "1h 05m" — rounds down. */
export const formatElapsed = (ms: number): string => {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	if (minutes === 0) return `${seconds}s`;
	const hours = Math.floor(minutes / 60);
	if (hours === 0) {
		return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	}
	return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
};

/** Counts in reading order: what is still running first, then outcomes. */
export const summarizeDelegationStatuses = (
	statuses: ReadonlyArray<DelegationStatus>,
): ReadonlyArray<{
	readonly status: DelegationStatus;
	readonly count: number;
}> => {
	const order: DelegationStatus[] = ["working", "done", "failed", "stopped"];
	return order
		.map((status) => ({
			status,
			count: statuses.filter((candidate) => candidate === status).length,
		}))
		.filter(({ count }) => count > 0);
};

/**
 * One elapsed span for a group: first start to last settle, live while any
 * member works. A settled member without an end leaves the span unknown, so
 * the end is withheld rather than cut short.
 */
export const delegationGroupTiming = (
	views: ReadonlyArray<
		Pick<DelegationView, "status" | "startedAt" | "completedAt">
	>,
): Pick<DelegationView, "status" | "startedAt" | "completedAt"> => {
	let startedAt: number | null = null;
	let completedAt: number | null = null;
	let endUnknown = false;
	for (const view of views) {
		if (view.startedAt !== null) {
			startedAt =
				startedAt === null
					? view.startedAt
					: Math.min(startedAt, view.startedAt);
		}
		if (view.completedAt !== null) {
			completedAt =
				completedAt === null
					? view.completedAt
					: Math.max(completedAt, view.completedAt);
		} else {
			endUnknown = true;
		}
	}
	const live = views.some((view) => view.status === "working");
	return {
		status: live ? "working" : "done",
		startedAt,
		completedAt: live || endUnknown ? null : completedAt,
	};
};

/** Elapsed ms at `now`, or null when the span cannot be known. */
export const delegationElapsedMs = (
	view: Pick<DelegationView, "status" | "startedAt" | "completedAt">,
	now: number,
): number | null => {
	if (view.startedAt === null) return null;
	if (view.completedAt !== null) {
		return Math.max(0, view.completedAt - view.startedAt);
	}
	return view.status === "working" ? Math.max(0, now - view.startedAt) : null;
};

const lastChildLine = (children: ReadonlyArray<Message>): string | null => {
	for (let index = children.length - 1; index >= 0; index -= 1) {
		const content = children[index]?.content;
		if (content?._tag === "assistant" && content.text.trim().length > 0) {
			return content.text;
		}
	}
	return null;
};

/** A native subagent, settled by its summary; inline ones stop with their parent. */
export const subagentDelegationView = (
	group: SubagentRenderGroup,
	context: {
		readonly providerId: ProviderId | null;
		readonly parentLive: boolean;
		readonly canReveal: boolean;
	},
): DelegationView => {
	const summary = group.summary;
	const startedAt = group.parent.createdAt.getTime();
	const lastChildAt = group.children.at(-1)?.createdAt.getTime() ?? null;
	const status: DelegationStatus =
		summary !== null
			? summary.isError
				? "failed"
				: "done"
			: group.presentation === "inline" && !context.parentLive
				? "stopped"
				: "working";
	return {
		id: group.parent.id,
		title: group.agentName,
		providerId: context.providerId,
		status,
		detail: delegationDetail(
			summary !== null && summary.text.trim().length > 0
				? summary.text
				: lastChildLine(group.children),
		),
		startedAt,
		completedAt:
			summary !== null
				? startedAt + summary.durationMs
				: status === "stopped"
					? lastChildAt
					: null,
		open:
			context.canReveal &&
			group.presentation === "detached" &&
			group.childSessionId !== undefined
				? { kind: "subagent", childSessionId: group.childSessionId }
				: null,
	};
};

/** What the parent knows about a spawned session from the shell and cache. */
export interface SpawnedSessionState {
	readonly providerId: ProviderId;
	readonly status: SessionStatus;
	readonly runtime: SessionRuntimeState;
	readonly messages: ReadonlyArray<Message>;
}

const inputRecord = (input: unknown): Record<string, unknown> =>
	input !== null && typeof input === "object"
		? (input as Record<string, unknown>)
		: {};

/** The spawn's chat and session ids, once its result has landed. */
export const spawnTarget = (
	member: Extract<DelegationMember, { kind: "spawn" }>,
): { readonly chatId: string; readonly sessionId: string | null } | null => {
	if (member.result === null) return null;
	const parsed = parseOrchestrationResult(member.result.output);
	if (typeof parsed?.chatId !== "string") return null;
	return {
		chatId: parsed.chatId,
		sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
	};
};

/** An orchestrated chat: live state comes from the spawned session itself. */
export const spawnDelegationView = (
	member: Extract<DelegationMember, { kind: "spawn" }>,
	context: {
		readonly fallbackProviderId: ProviderId | null;
		readonly session: SpawnedSessionState | null;
	},
): DelegationView => {
	const input = inputRecord(member.input);
	const parsed =
		member.result === null
			? null
			: parseOrchestrationResult(member.result.output);
	const target = spawnTarget(member);
	const session = context.session;
	const busy = session !== null && isSessionRuntimeBusy(session.runtime);
	const status: DelegationStatus =
		member.result === null || busy
			? "working"
			: session?.status === "error"
				? "failed"
				: "done";
	const lastMessage = session?.messages.at(-1) ?? null;
	const title =
		(typeof parsed?.title === "string" && parsed.title.trim()) ||
		(typeof input.title === "string" && input.title.trim()) ||
		delegationDetail(typeof input.task === "string" ? input.task : null) ||
		"";
	return {
		id: member.id,
		title,
		providerId:
			session?.providerId ??
			(isProviderId(input.providerId) ? input.providerId : null) ??
			context.fallbackProviderId,
		status,
		detail: delegationDetail(
			session === null ? null : lastChildLine(session.messages),
		),
		startedAt: member.createdAt.getTime(),
		completedAt:
			status === "working" || lastMessage === null
				? null
				: lastMessage.createdAt.getTime(),
		open:
			target !== null && target.sessionId !== null && session !== null
				? { kind: "chat", chatId: target.chatId, sessionId: target.sessionId }
				: null,
	};
};
