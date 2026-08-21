"use client";

import { motion, useInView, useReducedMotion } from "motion/react";
import Image from "next/image";
import { useRef } from "react";
import { cn } from "@/components/tpl/saas/lib/utils";

const EVENTS = [
	{
		name: "Claude Code",
		src: "/logos/claude.svg",
		text: "Step 3 failed: checkout button selector changed.",
		side: "left",
	},
	{
		name: "Codex",
		src: "/logos/openai.svg",
		text: "Updated the selector from the trace. Retrying now.",
		side: "right",
	},
	{
		name: "Claude Code",
		src: "/logos/claude.svg",
		text: "4/4 steps passed · trace saved · 1.8s",
		side: "left",
	},
] as const;

export function ChatConversation({ className }: { className?: string }) {
	const ref = useRef(null);
	const inView = useInView(ref, { once: true, margin: "-50px" });
	const reduceMotion = useReducedMotion();
	return (
		<div
			className={cn("flex min-h-60 items-center justify-center p-4", className)}
		>
			<div ref={ref} className="flex flex-col justify-center gap-3">
				{EVENTS.map((event, index) => (
					<div
						key={event.text}
						className={cn(
							"flex items-start gap-3",
							event.side === "right" && "flex-row-reverse",
						)}
					>
						<motion.span
							initial={false}
							animate={inView ? { opacity: 1, scale: 1 } : {}}
							transition={{
								duration: 0.24,
								delay: reduceMotion ? 0 : index * 0.16,
							}}
							className="grid size-8 shrink-0 place-items-center rounded-full bg-white ring-1 ring-black/5"
						>
							<Image src={event.src} alt="" width={16} height={16} />
						</motion.span>
						<motion.div
							initial={
								reduceMotion
									? false
									: { opacity: 0, x: event.side === "right" ? 10 : -10 }
							}
							animate={inView ? { opacity: 1, x: 0 } : {}}
							transition={{
								duration: 0.24,
								delay: reduceMotion ? 0 : index * 0.16 + 0.08,
							}}
							className="bg-card ring-border text-heading rounded-xl px-3 py-2 text-[10px] shadow-sm ring-1"
						>
							<span className="text-muted-foreground mb-0.5 block font-mono text-[8px]">
								{event.name}
							</span>
							{event.text}
						</motion.div>
					</div>
				))}
			</div>
		</div>
	);
}
