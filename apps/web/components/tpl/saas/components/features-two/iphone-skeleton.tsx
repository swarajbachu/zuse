"use client";

import { motion, useAnimate, useReducedMotion } from "motion/react";
import type React from "react";
import { useImperativeHandle, useRef } from "react";

interface IslandHandle {
	start: () => void;
	reset: () => void;
}
const SPRING = { type: "spring" as const, stiffness: 500, damping: 40 };

export function IPhoneSkeleton() {
	const island = useRef<IslandHandle>(null);
	const reduceMotion = useReducedMotion();
	return (
		<motion.div
			onHoverStart={() => !reduceMotion && island.current?.start()}
			onHoverEnd={() => !reduceMotion && island.current?.reset()}
		>
			<div className="relative mx-auto w-24">
				<div className="absolute top-10 -left-[2px] flex flex-col gap-1.5">
					<span className="h-2.5 w-[2px] rounded-l-sm bg-neutral-300 dark:bg-neutral-600" />
					<span className="h-4 w-[2px] rounded-l-sm bg-neutral-300 dark:bg-neutral-600" />
					<span className="h-4 w-[2px] rounded-l-sm bg-neutral-300 dark:bg-neutral-600" />
				</div>
				<span className="absolute top-14 -right-[2px] h-6 w-[2px] rounded-r-sm bg-neutral-300 dark:bg-neutral-600" />
				<div className="rounded-[1.25rem] bg-neutral-200 p-1 shadow-sm ring-1 ring-black/5 dark:bg-neutral-700 dark:ring-white/10">
					<div className="relative h-40 overflow-hidden rounded-[1rem] bg-white dark:bg-neutral-900">
						<motion.div
							variants={{
								initial: {
									opacity: reduceMotion ? 1 : 0,
									filter: reduceMotion ? "blur(0px)" : "blur(8px)",
								},
								animate: { opacity: 1, filter: "blur(0px)" },
							}}
							transition={{
								duration: reduceMotion ? 0 : 0.3,
								ease: "easeOut",
								delay: reduceMotion ? 0 : 0.2,
							}}
							className="absolute inset-0"
						>
							<div className="absolute inset-x-0 top-0 z-10">
								<DynamicIsland ref={island} />
							</div>
						</motion.div>
					</div>
				</div>
				<span className="absolute inset-x-0 bottom-1.5 mx-auto h-0.5 w-8 rounded-full bg-neutral-400 dark:bg-neutral-500" />
			</div>
		</motion.div>
	);
}

function DynamicIsland({ ref }: { ref: React.Ref<IslandHandle> }) {
	const [scope, animate] = useAnimate();
	const animated = useRef(false);
	const reset = () => {
		animated.current = false;
		animate(scope.current, { width: 28 }, SPRING);
		animate("#iphone-idle", { opacity: 1 }, { duration: 0.15 });
		animate("#iphone-loading", { opacity: 0 }, { duration: 0.1 });
		animate("#iphone-done", { opacity: 0 }, { duration: 0.1 });
	};
	const start = async () => {
		if (animated.current) return;
		animated.current = true;
		await animate("#iphone-idle", { opacity: 0 }, { duration: 0.1 });
		animate(scope.current, { width: 16 }, SPRING);
		await animate("#iphone-loading", { opacity: 1 }, { duration: 0.15 });
		await new Promise((resolve) => setTimeout(resolve, 1000));
		await animate("#iphone-loading", { opacity: 0 }, { duration: 0.1 });
		animate(scope.current, { width: 40 }, SPRING);
		await animate(
			"#iphone-done",
			{ opacity: 1 },
			{ duration: 0.15, delay: 0.1 },
		);
	};
	useImperativeHandle(ref, () => ({ start, reset }));
	return (
		<div className="flex justify-center pt-1.5">
			<div
				ref={scope}
				className="relative h-2.5 w-7 overflow-hidden rounded-full bg-black"
			>
				<div
					id="iphone-idle"
					className="absolute inset-0 flex items-center justify-center"
				>
					<span className="size-1 rounded-full bg-neutral-700" />
				</div>
				<div
					id="iphone-loading"
					className="absolute inset-0 flex items-center justify-center opacity-0"
				>
					<LoadingDots />
				</div>
				<div
					id="iphone-done"
					className="absolute inset-0 flex items-center justify-center opacity-0"
				>
					<span className="text-[3px] font-medium text-white">Connected</span>
				</div>
			</div>
		</div>
	);
}

function LoadingDots() {
	return (
		<div className="flex gap-px">
			{[0, 0.1, 0.2].map((delay) => (
				<motion.span
					key={delay}
					className="size-0.5 rounded-full bg-white"
					animate={{ opacity: [0.3, 1, 0.3] }}
					transition={{
						duration: 0.6,
						repeat: Number.POSITIVE_INFINITY,
						delay,
						ease: "easeInOut",
					}}
				/>
			))}
		</div>
	);
}
