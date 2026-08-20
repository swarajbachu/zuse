"use client";
import { motion, useInView, useReducedMotion } from "motion/react";
import { useRef } from "react";
import { cn } from "@/components/tpl/saas/lib/utils";

export function VerticalPulseLines({ className }: { className?: string }) {
	const ref = useRef(null);
	const isInView = useInView(ref, { once: true, margin: "-50px" });
	const reduceMotion = useReducedMotion();

	return (
		<div
			ref={ref}
			className={cn(
				"relative flex h-full w-full items-center justify-center gap-6 overflow-hidden px-8",
				className,
			)}
		>
			<div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-linear-to-b from-white to-transparent dark:from-neutral-900" />
			<div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-linear-to-t from-white to-transparent dark:from-neutral-900" />
			{[0, 1, 2, 3, 4, 5, 6].map((i) => (
				<div key={i} className="relative h-full w-px">
					<div className="absolute inset-0 border-l border-dashed border-neutral-300 dark:border-neutral-600" />
					<motion.div
						className="absolute left-0 h-12 w-px bg-linear-to-b from-transparent via-blue-500 to-transparent"
						initial={{ y: "-100%", opacity: 0 }}
						animate={
							isInView && !reduceMotion
								? {
										y: ["0%", "600%"],
										opacity: [0, 1, 1, 0],
									}
								: {}
						}
						transition={{
							duration: 1.5,
							delay: i * 0.2,
							repeat: reduceMotion ? 0 : Infinity,
							repeatDelay: 0.8,
							ease: "linear",
						}}
					/>
				</div>
			))}
		</div>
	);
}
