"use client";
import { motion, useMotionValue, useSpring, useTransform } from "motion/react";
import type React from "react";
import { useRef } from "react";
import { cn } from "@/components/tpl/nodus/lib/utils";
import { DivideX } from "./divide";

const springConfig = {
	stiffness: 300,
	damping: 30,
};

export const Card = ({
	title,
	subtitle,
	logo,
	cta,
	tone,
	className,
	delay = 0,
}: {
	title: string;
	subtitle: string;
	logo: React.ReactNode;
	cta: React.ReactNode;
	tone: "default" | "danger" | "success";
	className?: string;
	delay?: number;
}) => {
	const ref = useRef<HTMLDivElement>(null);

	const mouseX = useMotionValue(0);
	const mouseY = useMotionValue(0);

	const springX = useSpring(mouseX, springConfig);
	const springY = useSpring(mouseY, springConfig);

	const translateX = useTransform(springX, [-0.5, 0.5], [-20, 20]);
	const translateY = useTransform(springY, [-0.5, 0.5], [-20, 20]);

	const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
		if (!ref.current) return;

		const rect = ref.current.getBoundingClientRect();
		const centerX = rect.left + rect.width / 2;
		const centerY = rect.top + rect.height / 2;

		const x = (e.clientX - centerX) / rect.width;
		const y = (e.clientY - centerY) / rect.height;

		mouseX.set(x);
		mouseY.set(y);
	};

	const handleMouseLeave = () => {
		mouseX.set(0);
		mouseY.set(0);
	};

	return (
		<motion.div
			initial={{
				y: -20,
				opacity: 0,
			}}
			animate={{
				y: 0,
				opacity: 1,
			}}
			transition={{
				duration: 0.5,
				delay,
			}}
			className={cn("relative h-full text-xs", className)}
			ref={ref}
		>
			<div className="bg-card absolute inset-0 z-10 m-auto h-full w-full rounded-lg border border-(--pattern-fg) bg-[image:repeating-linear-gradient(315deg,_var(--pattern-fg)_0,_var(--pattern-fg)_1px,_transparent_0,_transparent_50%)] bg-[size:10px_10px] bg-fixed"></div>
			<div className="border-border bg-card absolute inset-x-0 -top-1.5 mx-auto size-3 rounded-full border-2"></div>

			<motion.div
				onMouseMove={handleMouseMove}
				onMouseLeave={handleMouseLeave}
				style={{
					translateX,
					translateY,
				}}
				className="bg-card relative z-20 flex w-54 shrink-0 flex-col items-start rounded-lg shadow-sm"
			>
				<div className="flex w-full items-center justify-between p-2 md:p-4">
					<div className="flex items-center gap-2 font-medium">
						{logo}
						{title}
					</div>
					<p className="text-muted-foreground font-mono">{subtitle}</p>
				</div>
				<DivideX />
				<div
					className={cn(
						"m-4 rounded-sm border px-2 py-0.5",
						tone === "default" &&
							"border-blue-500 bg-blue-50 text-blue-500 dark:bg-blue-50/10 dark:text-blue-500",
						tone === "danger" &&
							"border-orange-500 bg-red-50 text-orange-500 dark:bg-red-50/10 dark:text-red-500",
						tone === "success" &&
							"border-neutral-500 bg-neutral-50 text-neutral-500 dark:bg-neutral-50/10 dark:text-neutral-500",
					)}
				>
					{cta}
				</div>
			</motion.div>
		</motion.div>
	);
};
