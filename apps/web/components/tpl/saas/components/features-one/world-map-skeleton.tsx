"use client";

import {
	IconCheck,
	IconClick,
	IconForms,
	IconRoute,
	IconTarget,
} from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";

const STEPS = [
	{ icon: IconRoute, label: "Open /checkout", detail: "navigation" },
	{ icon: IconForms, label: "Enter card", detail: "input" },
	{ icon: IconClick, label: "Place order", detail: "click" },
	{ icon: IconTarget, label: "Receipt visible", detail: "assert" },
] as const;

export function WorldMapSkeleton() {
	const reduceMotion = useReducedMotion();
	return (
		<div className="relative mx-auto w-full max-w-2xl overflow-hidden px-5 pb-5 mask-radial-from-50% mask-t-from-90%">
			<div className="absolute top-1/2 right-8 left-8 h-px -translate-y-1/2 border-t border-dashed border-neutral-300 dark:border-neutral-700" />
			<div className="relative grid grid-cols-4 gap-2">
				{STEPS.map((step, index) => (
					<motion.div
						key={step.label}
						initial={false}
						whileInView={{ opacity: 1, y: 0 }}
						transition={{
							duration: 0.24,
							delay: reduceMotion ? 0 : index * 0.12,
						}}
						className="flex min-w-0 flex-col items-center text-center"
					>
						<span className="bg-card ring-border relative z-10 grid size-10 place-items-center rounded-xl ring-1 shadow-lg">
							<step.icon className="text-primary size-4" />
						</span>
						<p className="text-heading mt-2 truncate text-[9px] font-medium">
							{step.label}
						</p>
						<p className="text-muted-foreground font-mono text-[7px]">
							{step.detail}
						</p>
						<span className="bg-primary mt-2 grid size-4 place-items-center rounded-full">
							<IconCheck className="size-2.5 text-black" />
						</span>
					</motion.div>
				))}
			</div>
		</div>
	);
}
