import "@zuse/i18n/english/chat";
import type { Message } from "@zuse/contracts";
import { formatSentenceList } from "@zuse/i18n";
import { useMessages } from "@zuse/i18n/react";
import { ChevronDown } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import type { ComponentProps } from "react";
import { useId, useMemo, useRef } from "react";
import { isToolTreeBranch } from "../lib/chat-timeline-rows.ts";
import {
	toolActivityLabel,
	toolActivitySummary,
} from "../lib/tool-activity-label.ts";
import { normalizeToolCallEnvelope } from "../lib/tool-call-envelope.ts";
import { useTranscriptDisclosure } from "../store/transcript-disclosures.ts";
import { useChatLookups } from "./chat-lookups.tsx";
import { MessageRow } from "./message-row.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";

/** One disclosure owns the activity between text messages. */
export function ToolActivityTree({
	messages,
	live = false,
	...rowProps
}: {
	readonly messages: readonly Message[];
	readonly live?: boolean;
} & Omit<ComponentProps<typeof MessageRow>, "message">) {
	const { message } = useMessages(["chat"]);
	const [open, toggleOpen] = useTranscriptDisclosure(
		JSON.stringify([
			rowProps.environmentId,
			rowProps.sessionId ?? messages[0]?.sessionId,
			messages[0]?.id,
			"tools",
			live ? "live" : "settled",
		]),
		false,
	);
	const { resultsByItemId } = useChatLookups();
	const latest = messages.findLast(
		(item) => item.content._tag === "tool_use",
	)?.content;
	const tool = latest?._tag === "tool_use" ? latest : undefined;
	const localResult = tool
		? messages.findLast(
				(item) =>
					item.content._tag === "tool_result" &&
					item.content.itemId === tool.itemId,
			)?.content
		: undefined;
	const result =
		localResult?._tag === "tool_result"
			? localResult
			: tool
				? resultsByItemId.get(tool.itemId)
				: undefined;
	const active = live && tool !== undefined && result === undefined;
	const summary = useMemo(
		() =>
			toolActivitySummary(
				messages.flatMap((item) =>
					item.content._tag === "tool_use"
						? [
								normalizeToolCallEnvelope(
									item.content.tool,
									item.content.input,
									undefined,
								).tool,
							]
						: [],
				),
				message,
				formatSentenceList,
			),
		[messages, message],
	);
	const label =
		active && tool
			? toolActivityLabel(
					normalizeToolCallEnvelope(tool.tool, tool.input, undefined).tool,
					message,
				)
			: summary;
	const id = useId();
	const reduce = useReducedMotion();
	const initialIds = useRef(new Set(messages.map((item) => item.id)));
	const lastBranchId = messages.findLast(isToolTreeBranch)?.id;
	return (
		<div className="py-1">
			<button
				type="button"
				aria-label={label}
				aria-expanded={open}
				aria-controls={id}
				onClick={() => {
					initialIds.current = new Set(messages.map((item) => item.id));
					toggleOpen();
				}}
				className="flex h-7 max-w-full items-center gap-2 rounded ps-3 pe-4 text-xs text-muted-foreground hover:text-foreground"
			>
				<ChevronDown
					aria-hidden
					className={`size-3.5 transition-transform duration-150 motion-reduce:transition-none ${open ? "" : "-rotate-90"}`}
				/>
				<span className="min-w-0 truncate" role="status">
					{active ? <ShimmerText>{label}</ShimmerText> : label}
				</span>
			</button>
			<div id={id} hidden={!open} className="tool-activity-tree">
				{open
					? messages
							.filter(
								(item) =>
									item.content._tag !== "assistant" ||
									item.content.text.trim().length > 0,
							)
							.map((item) => (
								<motion.div
									initial={
										reduce || !live || initialIds.current.has(item.id)
											? false
											: { height: 0, y: -6 }
									}
									animate={{ height: "auto", y: 0 }}
									transition={{
										duration: reduce ? 0 : 0.28,
										ease: [0.22, 1, 0.36, 1],
									}}
									key={item.id}
									className={
										isToolTreeBranch(item)
											? `overflow-hidden tool-activity-branch ${item.id === lastBranchId ? "tool-activity-last" : ""}`
											: "overflow-hidden"
									}
								>
									<MessageRow {...rowProps} message={item} />
								</motion.div>
							))
					: null}
			</div>
		</div>
	);
}
