"use client";
import { motion, useMotionValue, useReducedMotion } from "motion/react";
import type React from "react";
import { useEffect, useId } from "react";
import { IntegrationsLogo } from "@/components/tpl/nodus/icons/bento-icons";
import {
	AnthropicLogo,
	ForkIcon,
	OpenAILogo,
} from "@/components/tpl/nodus/icons/general";
import { cn } from "@/components/tpl/nodus/lib/utils";
import { DivideX } from "../divide";
import { LogoSVG } from "../logo";
import { Scale } from "../scale";
import { Card } from "../tech-card";

export const SharedWorktreeSkeleton = () => {
	return (
		<div className="mt-12 flex flex-col items-center">
			<div className="relative">
				<Card
					title="checkout-recovery"
					subtitle="agent/checkout-recovery"
					logo={<LogoSVG />}
					cta="Shared worktree"
					tone="default"
				/>
				<LeftSVG className="absolute top-12 -left-32" />
				<RightSVG className="absolute top-12 -right-32" />
				<CenterSVG className="absolute top-24 right-[107px]" />
			</div>

			<div className="mt-12 flex flex-row gap-4.5">
				<Card
					title="Claude Code"
					subtitle="Implementation"
					logo={<AnthropicLogo />}
					cta="Running"
					tone="danger"
					delay={0.2}
				/>
				<Card
					title="Terminal"
					subtitle="Focused tests"
					logo={<ForkIcon />}
					cta="16 passed"
					tone="default"
					delay={0.4}
				/>
				<Card
					title="Codex"
					subtitle="Diff review"
					logo={<OpenAILogo />}
					cta="Reviewing"
					tone="success"
					delay={0.6}
				/>
			</div>
		</div>
	);
};

export const ContextReviewSkeleton = () => {
	const text = `Review the current diff and verify checkout recovery without editing.`;
	const randomWidth = 78;

	return (
		<div className="relative flex h-full w-full items-center justify-between">
			<motion.div
				initial={{ y: -20, opacity: 0 }}
				animate={{ y: 0, opacity: 1 }}
				transition={{ duration: 0.5 }}
				className="border-border bg-card relative h-70 w-60 -translate-x-2 rounded-2xl border-t p-4 shadow-2xl md:translate-x-0"
			>
				<div className="bg-card absolute -top-4 -right-4 flex h-14 w-14 items-center justify-center rounded-lg shadow-xl">
					<Scale />
					<OpenAILogo className="relative z-20 h-8 w-8" />
				</div>
				<div className="mt-12 flex items-center gap-2">
					<IntegrationsLogo />
					<span className="text-heading text-sm font-medium">
						Shared context
					</span>
				</div>
				<DivideX className="mt-2" />

				<div className="mt-4 flex items-center justify-between gap-2">
					<div className="flex items-center gap-2">
						<span className="text-heading text-[10px] leading-loose font-normal md:text-xs">
							<motion.span
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								transition={{ duration: 0.4 }}
							>
								{text}
							</motion.span>
						</span>
					</div>
				</div>
				<div className="mt-2 flex flex-col">
					{["context-a", "context-b"].map((bar, index) => (
						<motion.div
							key={bar}
							initial={{
								width: "0%",
							}}
							animate={{
								width: `${randomWidth}%`,
							}}
							transition={{
								duration: 4,
								delay: index * 0.2,
								ease: "easeInOut",
								repeat: Infinity,
								repeatType: "reverse",
							}}
							className="mt-2 h-4 w-full rounded-full bg-gray-200 dark:bg-neutral-800"
						/>
					))}
				</div>
			</motion.div>

			<motion.div
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				transition={{ duration: 1, delay: 1 }}
				className="absolute inset-x-0 z-30 hidden items-center justify-center md:flex"
			>
				<div className="size-3 rounded-full border-2 border-blue-500 bg-white dark:bg-neutral-800" />
				<div className="h-[2px] w-38 bg-blue-500" />
				<div className="size-3 rounded-full border-2 border-blue-500 bg-white dark:bg-neutral-800" />
			</motion.div>
			<motion.div
				initial={{ y: -20, opacity: 0 }}
				animate={{ y: 0, opacity: 1 }}
				transition={{ duration: 0.5, delay: 1 }}
				className="border-border bg-card relative h-70 w-60 translate-x-10 rounded-2xl border-t p-4 shadow-2xl md:translate-x-0"
			>
				<div className="bg-card absolute -top-4 -left-4 flex h-14 w-14 items-center justify-center rounded-lg shadow-xl">
					<Scale />
					<LogoSVG className="relative z-20 h-8 w-8" />
				</div>
				<div className="mt-12 flex items-center gap-2">
					<IntegrationsLogo className="dark:text-neutral-200" />
					<span className="text-heading text-xs font-medium md:text-sm">
						Worktree tabs
					</span>
					<span className="border-border bg-elevated text-heading rounded-lg border px-2 py-0.5 text-xs">
						3
					</span>
				</div>
				<DivideX className="mt-2" />
				<div className="mt-4 flex items-center justify-between gap-2">
					<div className="flex items-center gap-2">
						<OpenAILogo className="h-4 w-4 shrink-0" />
						<span className="text-heading text-xs font-medium md:text-sm">
							Codex · review
						</span>
					</div>

					<div className="rounded-sm border border-blue-500 bg-blue-50 px-2 py-0.5 text-xs text-blue-500">
						Connected
					</div>
				</div>
				<div className="mt-4 flex items-center justify-between gap-2">
					<div className="flex items-center gap-2">
						<AnthropicLogo className="h-4 w-4 shrink-0" />
						<span className="text-heading text-xs font-medium md:text-sm">
							Claude Code · build
						</span>
					</div>

					<div className="rounded-sm border border-blue-500 bg-blue-50 px-2 py-0.5 text-xs text-blue-500">
						Connected
					</div>
				</div>
				<div className="mt-2 flex flex-col">
					{[65, 82, 74].map((width, index) => (
						<motion.div
							key={width}
							initial={{
								width: `${width - 20}%`,
							}}
							animate={{
								width: `${width}%`,
							}}
							transition={{
								duration: 4,
								delay: index * 0.2,
								ease: "easeInOut",
								repeat: Infinity,
								repeatType: "reverse",
							}}
							className="mt-2 h-4 w-full rounded-full bg-gray-200 dark:bg-neutral-800"
						/>
					))}
				</div>
			</motion.div>
		</div>
	);
};

export const EvidenceTimelineSkeleton = () => {
	const deployCards = [
		{
			title: "Claude · implementation",
			subtitle: "running",
			branch: "agent/checkout-recovery",
		},
		{
			title: "Codex · diff review",
			subtitle: "2 findings",
			branch: "agent/checkout-recovery",
			variant: "success" as const,
		},
		{
			title: "Terminal · focused tests",
			subtitle: "16 passed",
			branch: "agent/checkout-recovery",
			variant: "success" as const,
		},
		{
			title: "Changes · 12 files",
			subtitle: "+184 −32",
			branch: "agent/checkout-recovery",
			variant: "success" as const,
		},
		{
			title: "Codex · review resolved",
			subtitle: "2 fixes",
			branch: "agent/checkout-recovery",
			variant: "warning" as const,
		},
		{
			title: "PR #814 · ready",
			subtitle: "checks passed",
			branch: "agent/checkout-recovery",
			variant: "success" as const,
		},
	];

	const extendedCards = [0, 1, 2].flatMap((round) =>
		deployCards.map((card) => ({ ...card, id: `${round}-${card.title}` })),
	);

	const cardHeight = 64;
	const gap = 4;
	const itemHeight = cardHeight + gap;

	const y = useMotionValue(0);
	const reduceMotion = useReducedMotion();
	const totalHeight = extendedCards.length * itemHeight;

	useEffect(() => {
		if (reduceMotion) return;
		let animationFrame: number;
		let lastTime = performance.now();
		const speed = 30;

		function animateScroll(now: number) {
			const elapsed = (now - lastTime) / 1000;
			lastTime = now;
			let current = y.get();
			current -= speed * elapsed;

			if (Math.abs(current) >= totalHeight / 3) {
				current += totalHeight / 3;
			}
			y.set(current);
			animationFrame = requestAnimationFrame(animateScroll);
		}
		animationFrame = requestAnimationFrame(animateScroll);
		return () => cancelAnimationFrame(animationFrame);
	}, [reduceMotion, y, totalHeight]);

	return (
		<div
			className="relative h-full w-full overflow-hidden"
			style={{
				maskImage:
					"linear-gradient(to bottom, transparent 0%, black 20%, black 80%, transparent 100%)",
				WebkitMaskImage:
					"linear-gradient(to bottom, transparent 0%, black 20%, black 80%, transparent 100%)",
			}}
		>
			<motion.div
				className="absolute left-1/2 flex w-full -translate-x-1/2 flex-col items-center"
				style={{ y }}
			>
				{extendedCards.map((card, index) => (
					<motion.div
						key={card.id}
						className="mx-auto mt-4 w-full max-w-sm shrink-0 rounded-2xl shadow-xl"
						style={{ scale: index % deployCards.length === 2 ? 1.05 : 0.94 }}
					>
						<DeployCard
							variant={card.variant}
							title={card.title}
							subtitle={card.subtitle}
							branch={card.branch}
						/>
					</motion.div>
				))}
			</motion.div>
		</div>
	);
};

const DeployCard = ({
	variant = "default",
	title,
	subtitle,
	branch,
}: {
	variant?: "default" | "danger" | "success" | "warning";
	title: string;
	subtitle: string;
	branch: string;
}) => {
	return (
		<div className="border-border bg-card mx-auto flex w-full max-w-sm items-center justify-between rounded-lg border p-3">
			<div className="flex items-center gap-2">
				<div
					className={cn(
						"flex h-6 w-6 items-center justify-center rounded-md",
						variant === "default" && "bg-gray-200",
						variant === "danger" && "bg-red-200",
						variant === "success" && "bg-green-200",
						variant === "warning" && "bg-yellow-200",
					)}
				>
					<ForkIcon
						className={cn(
							"h-4 w-4",
							variant === "default" && "text-gray-500",
							variant === "danger" && "text-red-500",
							variant === "success" && "text-green-500",
							variant === "warning" && "text-yellow-500",
						)}
					/>
				</div>
				<span className="text-heading text-xs font-medium sm:text-sm">
					{title}
				</span>
			</div>
			<div className="ml-2 flex flex-row items-center gap-2">
				<span className="text-muted-foreground text-xs font-normal">
					{subtitle}
				</span>
				<div className="size-1 rounded-full bg-gray-400"></div>
				<span className="text-muted-foreground text-xs font-normal">
					{branch}
				</span>
			</div>
		</div>
	);
};

const LeftSVG = (props: React.SVGProps<SVGSVGElement>) => {
	const maskId = useId();
	const gradientId = useId();
	return (
		<motion.svg
			aria-hidden="true"
			width="128"
			height="97"
			viewBox="0 0 128 97"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			initial={{
				opacity: 0,
			}}
			animate={{
				opacity: 1,
			}}
			transition={{
				duration: 1,
			}}
			className={props.className}
		>
			<mask id={maskId} fill="var(--color-line)">
				<path d="M127.457 0.0891113L127.576 95.9138L0.939007 96.0718L0.839368 16.2472C0.828338 7.41063 7.98283 0.238242 16.8194 0.227212L127.457 0.0891113Z" />
			</mask>
			<path
				d="M127.457 0.0891113L127.576 95.9138L127.457 0.0891113ZM-0.0609919 96.0731L-0.160632 16.2484C-0.172351 6.85959 7.4293 -0.761068 16.8181 -0.772787L16.8206 1.22721C8.53637 1.23755 1.82903 7.96166 1.83937 16.2459L1.93901 96.0706L-0.0609919 96.0731ZM-0.160632 16.2484C-0.172351 6.85959 7.4293 -0.761068 16.8181 -0.772787L127.455 -0.910888L127.458 1.08911L16.8206 1.22721C8.53637 1.23755 1.82903 7.96166 1.83937 16.2459L-0.160632 16.2484ZM127.576 95.9138L0.939007 96.0718L127.576 95.9138Z"
				fill="#EAEDF1"
				mask={`url(#${maskId})`}
			/>
			<path
				d="M127.457 0.0891113L127.576 95.9138L127.457 0.0891113ZM-0.0609919 96.0731L-0.160632 16.2484C-0.172351 6.85959 7.4293 -0.761068 16.8181 -0.772787L16.8206 1.22721C8.53637 1.23755 1.82903 7.96166 1.83937 16.2459L1.93901 96.0706L-0.0609919 96.0731ZM-0.160632 16.2484C-0.172351 6.85959 7.4293 -0.761068 16.8181 -0.772787L127.455 -0.910888L127.458 1.08911L16.8206 1.22721C8.53637 1.23755 1.82903 7.96166 1.83937 16.2459L-0.160632 16.2484ZM127.576 95.9138L0.939007 96.0718L127.576 95.9138Z"
				fill={`url(#${gradientId})`}
				mask={`url(#${maskId})`}
			/>
			{/* <rect d={path} width="128" height="97" fill="url(#gradient-one)" /> */}
			<defs>
				<motion.linearGradient
					id={gradientId}
					initial={{
						x1: "100%",
						x2: "90%",
						y1: "90%",
						y2: "80%",
					}}
					animate={{
						x1: "20%",
						x2: "0%",
						y1: "90%",
						y2: "220%",
					}}
					transition={{
						duration: 5,
						repeat: Infinity,
						repeatDelay: 2,
					}}
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="var(--color-line)" stopOpacity="0.5" offset="0" />
					<stop stopColor="#5787FF" stopOpacity="1" offset="0.5" />
					<stop stopColor="var(--color-line)" stopOpacity="0" offset="1" />
				</motion.linearGradient>
			</defs>
		</motion.svg>
	);
};

const RightSVG = (props: React.SVGProps<SVGSVGElement>) => {
	const maskId = useId();
	const gradientId = useId();
	return (
		<motion.svg
			aria-hidden="true"
			width="128"
			height="96"
			viewBox="0 0 128 96"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			initial={{
				opacity: 0,
			}}
			animate={{
				opacity: 1,
			}}
			transition={{
				duration: 1,
			}}
			className={props.className}
		>
			<mask id={maskId} fill="var(--color-line)">
				<path d="M0.619629 0L0.500018 95.8247L127.137 95.9827L127.237 16.1581C127.248 7.32152 120.093 0.149131 111.257 0.138101L0.619629 0Z" />
			</mask>
			<path
				d="M0.619629 0L0.500018 95.8247L0.619629 0ZM128.137 95.984L128.237 16.1593C128.249 6.77047 120.647 -0.850179 111.258 -0.861898L111.256 1.1381C119.54 1.14844 126.247 7.87255 126.237 16.1568L126.137 95.9815L128.137 95.984ZM128.237 16.1593C128.249 6.77047 120.647 -0.850179 111.258 -0.861898L0.620877 -0.999999L0.618381 0.999999L111.256 1.1381C119.54 1.14844 126.247 7.87255 126.237 16.1568L128.237 16.1593ZM0.500018 95.8247L127.137 95.9827L0.500018 95.8247Z"
				fill="#EAEDF1"
				mask={`url(#${maskId})`}
			/>
			<path
				d="M0.619629 0L0.500018 95.8247L0.619629 0ZM128.137 95.984L128.237 16.1593C128.249 6.77047 120.647 -0.850179 111.258 -0.861898L111.256 1.1381C119.54 1.14844 126.247 7.87255 126.237 16.1568L126.137 95.9815L128.137 95.984ZM128.237 16.1593C128.249 6.77047 120.647 -0.850179 111.258 -0.861898L0.620877 -0.999999L0.618381 0.999999L111.256 1.1381C119.54 1.14844 126.247 7.87255 126.237 16.1568L128.237 16.1593ZM0.500018 95.8247L127.137 95.9827L0.500018 95.8247Z"
				fill={`url(#${gradientId})`}
				mask={`url(#${maskId})`}
			/>
			{/* <rect d={PATH} width="128" height="97" fill="url(#gradient-two)" /> */}

			<defs>
				<motion.linearGradient
					id={gradientId}
					initial={{
						x1: "-10%",
						x2: "0%",
						y1: "0%",
						y2: "0%",
					}}
					animate={{
						x1: "100%",
						x2: "110%",
						y1: "110%",
						y2: "140%",
					}}
					transition={{
						duration: 5,
						repeat: Infinity,
						repeatDelay: 2,
					}}
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="white" stopOpacity="0.5" offset="0" />
					<stop stopColor="#F17463" stopOpacity="1" offset="0.5" />
					<stop stopColor="white" stopOpacity="0" offset="1" />
				</motion.linearGradient>
			</defs>
		</motion.svg>
	);
};

const CenterSVG = (props: React.SVGProps<SVGSVGElement>) => {
	const gradientId = useId();
	return (
		<motion.svg
			aria-hidden="true"
			width="2"
			height="56"
			viewBox="0 0 2 56"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			initial={{
				opacity: 0,
			}}
			animate={{
				opacity: 1,
			}}
			transition={{
				duration: 1,
			}}
			className={props.className}
		>
			<line x1="1" y1="56" x2="1" stroke="var(--color-line)" strokeWidth="2" />
			<line
				x1="1"
				y1="56"
				x2="1"
				stroke={`url(#${gradientId})`}
				strokeWidth="1"
			/>
			<defs>
				<motion.linearGradient
					id={gradientId}
					initial={{
						x1: "0%",
						x2: "0%",
						y1: "-100%",
						y2: "-90%",
					}}
					animate={{
						x1: "0%",
						x2: "0%",
						y1: "90%",
						y2: "100%",
					}}
					transition={{
						duration: 5,
						repeat: Infinity,
						repeatDelay: 2,
					}}
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="var(--color-line)" stopOpacity="1" offset="0" />
					<stop stopColor="#F17463" stopOpacity="0.5" offset="0.5" />
					<stop stopColor="#F17463" stopOpacity="0" offset="1" />
				</motion.linearGradient>
			</defs>
		</motion.svg>
	);
};
