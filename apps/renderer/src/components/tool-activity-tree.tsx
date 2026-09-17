import "@zuse/i18n/english/chat";
import type { Message } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { ChevronDown } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import type { ComponentProps } from "react";
import { useId, useRef, useState } from "react";
import { MessageRow } from "./message-row.tsx";

/** One disclosure owns the activity between text messages. */
export function ToolActivityTree({
	messages,
	...rowProps
}: {
	readonly messages: readonly Message[];
} & Omit<ComponentProps<typeof MessageRow>, "message">) {
	const { message } = useMessages(["chat"]);
	const [open, setOpen] = useState(true);
	const id = useId();
	const reduce = useReducedMotion();
	const initialIds = useRef(new Set(messages.map((item) => item.id)));
	const lastToolId = messages.findLast(
		(item) => item.content._tag === "tool_use",
	)?.id;
	const count = messages.filter((m) => m.content._tag === "tool_use").length;
	return (
		<div className="py-1">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={id}
				onClick={() => setOpen((value) => !value)}
				className="flex h-7 items-center gap-2 rounded text-xs text-muted-foreground hover:text-foreground"
			>
				<ChevronDown
					aria-hidden
					className={`size-3.5 transition-transform duration-150 motion-reduce:transition-none ${open ? "" : "-rotate-90"}`}
				/>
				<span className="tabular-nums">{count}</span>
				<span>
					{message("chat:turn_summary_tool")}
					{count === 1
						? message("chat:turn_summary_call")
						: message("chat:turn_summary_calls")}
				</span>
			</button>
			<div id={id} hidden={!open} className="tool-activity-tree ml-5">
				{messages
					.filter(
						(item) =>
							item.content._tag !== "assistant" ||
							item.content.text.trim().length > 0,
					)
					.map((item) => (
						<motion.div
							initial={
								reduce || initialIds.current.has(item.id)
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
								item.content._tag === "tool_use"
									? `overflow-hidden tool-activity-branch ${item.id === lastToolId ? "tool-activity-last" : ""}`
									: "overflow-hidden"
							}
						>
							<MessageRow {...rowProps} message={item} />
						</motion.div>
					))}
			</div>
		</div>
	);
}
