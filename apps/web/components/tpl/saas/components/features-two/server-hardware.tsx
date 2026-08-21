"use client";

import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

export function ServerHardware({ className }: { className?: string }) {
	const reduceMotion = useReducedMotion();

	return (
		<svg
			viewBox="24 8 232 180"
			className={cn("overflow-visible", className)}
			role="img"
			aria-label="Three rack-mounted servers online"
		>
			<defs>
				<pattern
					id="server-vents"
					width="6"
					height="6"
					patternUnits="userSpaceOnUse"
				>
					<circle cx="2" cy="2" r="0.8" className="fill-muted-foreground/35" />
				</pattern>
				<filter id="server-shadow" x="-30%" y="-30%" width="160%" height="180%">
					<feDropShadow dx="0" dy="12" stdDeviation="12" floodOpacity="0.18" />
				</filter>
			</defs>

			<ellipse
				cx="140"
				cy="176"
				rx="102"
				ry="10"
				className="fill-neutral-950/10 dark:fill-black/35"
			/>
			<g filter="url(#server-shadow)">
				<path
					d="M38 31 52 19h190v137l-14 14H38Z"
					className="fill-neutral-200 stroke-neutral-300 dark:fill-neutral-700 dark:stroke-neutral-600"
					strokeWidth="1.5"
				/>
				<path
					d="M228 31 242 19v137l-14 14Z"
					className="fill-neutral-300 stroke-neutral-300 dark:fill-neutral-800 dark:stroke-neutral-600"
					strokeWidth="1.5"
				/>

				{[38, 81, 124].map((y, serverIndex) => (
					<g key={y}>
						<rect
							x="38"
							y={y}
							width="190"
							height="36"
							rx="4"
							className="fill-white stroke-neutral-300 dark:fill-neutral-800 dark:stroke-neutral-600"
							strokeWidth="1.5"
						/>
						<circle
							cx="51"
							cy={y + 18}
							r="3"
							className="fill-neutral-300 dark:fill-neutral-950"
						/>
						<motion.circle
							cx="51"
							cy={y + 18}
							r="1.5"
							className="fill-primary"
							animate={reduceMotion ? undefined : { opacity: [0.35, 1, 0.35] }}
							transition={{
								duration: 1.8,
								repeat: Number.POSITIVE_INFINITY,
								delay: serverIndex * 0.3,
								ease: "easeInOut",
							}}
						/>
						<rect
							x="63"
							y={y + 9}
							width="75"
							height="18"
							rx="2"
							fill="url(#server-vents)"
						/>
						{[0, 1, 2].map((bay) => (
							<g key={bay}>
								<rect
									x={149 + bay * 22}
									y={y + 8}
									width="17"
									height="20"
									rx="2"
									className="fill-neutral-100 stroke-neutral-300 dark:fill-neutral-950 dark:stroke-neutral-600"
									strokeWidth="1"
								/>
								<path
									d={`M${153 + bay * 22} ${y + 23}h9`}
									className="stroke-muted-foreground/40"
									strokeWidth="1"
								/>
							</g>
						))}
					</g>
				))}
			</g>
		</svg>
	);
}
