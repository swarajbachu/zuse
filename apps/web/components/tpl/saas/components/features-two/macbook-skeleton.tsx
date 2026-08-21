"use client";

import { motion, useAnimate, useReducedMotion } from "motion/react";
import Image from "next/image";
import type React from "react";
import { useImperativeHandle, useRef } from "react";

interface IslandHandle {
	start: () => void;
	reset: () => void;
}
const SPRING = { type: "spring" as const, stiffness: 500, damping: 40 };

export function MacbookSkeleton() {
	const island = useRef<IslandHandle>(null);
	const reduceMotion = useReducedMotion();
	return (
		<motion.div
			onHoverStart={() => !reduceMotion && island.current?.start()}
			onHoverEnd={() => !reduceMotion && island.current?.reset()}
		>
			<div className="mx-auto w-80 max-w-full perspective-distant">
				<motion.div
					style={{ transformOrigin: "bottom" }}
					variants={{
						initial: reduceMotion ? { rotateX: 0 } : { rotateX: -60 },
						animate: { rotateX: 20 },
					}}
					transition={{
						duration: reduceMotion ? 0 : 0.98,
						ease: [0.901, 0.016, 0, 1.032],
					}}
					className="mx-auto h-44 w-[90%] rounded-t-lg bg-neutral-200 p-1.5 shadow-sm ring-1 ring-black/5 dark:bg-neutral-700 dark:ring-white/10"
				>
					<div className="relative h-full overflow-hidden rounded-t-md rounded-b-sm bg-white dark:bg-neutral-900">
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
								delay: reduceMotion ? 0 : 0.5,
							}}
							className="absolute inset-0"
						>
							<Image
								src="/assets/product/zuse-workspace.png"
								alt="Zuse desktop workspace"
								fill
								sizes="288px"
								className="object-cover object-left-top"
							/>
							<div className="absolute inset-x-0 top-0 z-10">
								<DynamicIsland ref={island} />
							</div>
						</motion.div>
					</div>
				</motion.div>
				<div className="relative h-3.5 rounded-t-md rounded-br-3xl rounded-bl-3xl bg-linear-to-b from-neutral-200 to-neutral-300 dark:from-neutral-600 dark:to-neutral-800">
					<div className="absolute inset-x-0 top-0 mx-auto h-1.5 w-12 rounded-b-sm bg-neutral-400 dark:bg-neutral-500" />
				</div>
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
		animate("#mac-idle", { opacity: 1 }, { duration: 0.15 });
		animate("#mac-loading", { opacity: 0 }, { duration: 0.1 });
		animate("#mac-done", { opacity: 0 }, { duration: 0.1 });
	};
	const start = async () => {
		if (animated.current) return;
		animated.current = true;
		await animate("#mac-idle", { opacity: 0 }, { duration: 0.1 });
		animate(scope.current, { width: 16 }, SPRING);
		await animate("#mac-loading", { opacity: 1 }, { duration: 0.15 });
		await new Promise((resolve) => setTimeout(resolve, 1000));
		await animate("#mac-loading", { opacity: 0 }, { duration: 0.1 });
		animate(scope.current, { width: 48 }, SPRING);
		await animate("#mac-done", { opacity: 1 }, { duration: 0.15, delay: 0.1 });
	};
	useImperativeHandle(ref, () => ({ start, reset }));
	return (
		<div className="flex justify-center pt-1.5">
			<div
				ref={scope}
				className="relative h-2.5 w-7 overflow-hidden rounded-full bg-black"
			>
				<div
					id="mac-idle"
					className="absolute inset-0 flex items-center justify-center"
				>
					<span className="size-1 rounded-full bg-neutral-700" />
				</div>
				<div
					id="mac-loading"
					className="absolute inset-0 flex items-center justify-center opacity-0"
				>
					<LoadingDots />
				</div>
				<div
					id="mac-done"
					className="absolute inset-0 flex items-center justify-center opacity-0"
				>
					<span className="text-[3px] font-medium text-white">
						Agent finished
					</span>
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
