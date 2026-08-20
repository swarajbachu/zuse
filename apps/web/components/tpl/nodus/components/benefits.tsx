"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Image from "next/image";
import type React from "react";
import { useEffect, useState } from "react";
import {
	BellIcon,
	GraphIcon,
	ReuseBrainIcon,
	RocketIcon,
	ScreenCogIcon,
	ShieldIcon,
} from "@/components/tpl/nodus/icons/card-icons";
import { Badge } from "./badge";
import { HorizontalLine } from "./common/horizontal-line";
import { IconBlock } from "./common/icon-block";
import { VerticalLine } from "./common/vertical-line";
import { Container } from "./container";
import { DivideX } from "./divide";
import { LogoSVG } from "./logo";
import { SectionHeading } from "./seciton-heading";
import { SubHeading } from "./subheading";

export const Benefits = () => {
	const benefits = [
		{
			title: "Start from a Linear issue",
			description:
				"Search connected workspaces and create an agent run from one or more issues.",
			icon: <RocketIcon className="text-brand size-6" />,
		},
		{
			title: "Attach complete issue context",
			description:
				"Bring the issue description and comments into the agent thread.",
			icon: <GraphIcon className="text-brand size-6" />,
		},
		{
			title: "Let agents update Linear",
			description:
				"Agents can read issues, add comments, and update fields through the integration.",
			icon: <BellIcon className="text-brand size-6" />,
		},
		{
			title: "Review GitHub pull requests",
			description:
				"Inspect the branch diff, checks, reviews, and inline feedback in Zuse.",
			icon: <ReuseBrainIcon className="text-brand size-6" />,
		},
		{
			title: "Manage review feedback",
			description:
				"Create, edit, resolve, and delete inline GitHub review comments.",
			icon: <ScreenCogIcon className="text-brand size-6" />,
		},
		{
			title: "Merge with guardrails",
			description:
				"Choose merge, squash, or rebase, and use GitHub auto-merge when allowed.",
			icon: <ShieldIcon className="text-brand size-6" />,
		},
	];
	return (
		<Container className="border-divide relative overflow-hidden border-x px-4 py-20 md:px-8">
			<div className="relative flex flex-col items-center">
				<Badge text="Integrations" />
				<SectionHeading className="mt-4">
					Plugs into the tools you already use
				</SectionHeading>

				<SubHeading as="p" className="mx-auto mt-6 max-w-lg">
					Start from Linear, carry the issue into the run, and review the
					resulting branch and pull request with GitHub.
				</SubHeading>
			</div>
			<div className="mt-20 grid grid-cols-1 gap-4 md:grid-cols-3">
				<div className="grid grid-cols-1 gap-4">
					{benefits.slice(0, 3).map((benefit) => (
						<Card key={benefit.title} {...benefit} />
					))}
				</div>
				<MiddleCard />
				<div className="grid grid-cols-1 gap-4">
					{benefits.slice(3, 6).map((benefit) => (
						<Card key={benefit.title} {...benefit} />
					))}
				</div>
			</div>
		</Container>
	);
};

const MiddleCard = () => {
	const texts = [
		"Issue attached from Linear",
		"Branch reviewed in Zuse",
		"Pull request open on GitHub",
	];
	const [activeText, setActiveText] = useState(0);
	const shouldReduceMotion = useReducedMotion();
	useEffect(() => {
		if (shouldReduceMotion) return;
		const interval = setInterval(() => {
			setActiveText((prev) => (prev + 1) % 3);
		}, 4000);
		return () => clearInterval(interval);
	}, [shouldReduceMotion]);
	return (
		<div className="bg-card relative flex min-h-40 flex-col justify-end overflow-hidden rounded-lg p-4 md:p-5">
			<div className="absolute inset-0 bg-[radial-gradient(var(--color-dots)_1px,transparent_1px)] mask-radial-from-10% [background-size:10px_10px] shadow-xl"></div>

			<div className="flex items-center justify-center">
				<IconBlock
					icon={
						<Image
							src="/logos/linear.svg"
							alt="Linear"
							width={24}
							height={24}
							className="size-6 object-contain"
						/>
					}
				/>
				<HorizontalLine />
				<div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md bg-gray-200 p-px shadow-xl dark:bg-neutral-700">
					<div className="absolute inset-0 scale-[1.4] rounded-full bg-conic motion-safe:animate-spin [background-image:conic-gradient(at_center,transparent,var(--color-blue-500)_20%,transparent_30%)] [animation-duration:2s]"></div>
					<div className="via-brand absolute inset-0 scale-[1.4] rounded-full bg-conic motion-safe:animate-spin [background-image:conic-gradient(at_center,transparent,var(--color-brand)_20%,transparent_30%)] [animation-delay:1s] [animation-duration:2s]"></div>
					<div className="bg-card relative z-20 flex h-full w-full items-center justify-center rounded-[5px]">
						<LogoSVG />
					</div>
				</div>
				<HorizontalLine />
				<IconBlock
					icon={
						<Image
							src="/logos/github.svg"
							alt="GitHub"
							width={24}
							height={24}
							className="size-6 object-contain"
						/>
					}
				/>
			</div>
			<div className="relative z-20 flex flex-col items-center justify-center">
				<VerticalLine />
				<div className="rounded-sm border border-blue-500 bg-blue-50 px-2 py-0.5 text-xs text-blue-500 dark:bg-blue-900 dark:text-white">
					Connected
				</div>
			</div>
			<div className="h-60 w-full translate-x-10 translate-y-10 overflow-hidden rounded-md bg-gray-200 p-px shadow-xl dark:bg-neutral-700">
				<div className="absolute inset-0 scale-[1.4] rounded-full bg-conic from-transparent via-blue-500 via-20% to-transparent to-30% blur-2xl motion-safe:animate-spin [animation-duration:4s]"></div>
				<div className="via-brand absolute inset-0 scale-[1.4] rounded-full bg-conic from-transparent via-20% to-transparent to-30% blur-2xl motion-safe:animate-spin [animation-delay:2s] [animation-duration:4s]"></div>
				<div className="bg-card relative z-20 h-full w-full rounded-[5px]">
					<div className="flex items-center justify-between p-4">
						<div className="flex gap-1">
							<div className="size-2 rounded-full bg-red-400"></div>
							<div className="size-2 rounded-full bg-yellow-400"></div>
							<div className="size-2 rounded-full bg-green-400"></div>
						</div>
						<AnimatePresence mode="wait">
							<motion.div
								className="bg-elevated text-muted-foreground mr-2 flex items-center gap-1 rounded-sm px-2 py-1 text-xs shadow-sm"
								key={activeText}
								initial={{ opacity: 0, y: -10 }}
								animate={{ opacity: 1, y: 0 }}
								exit={{ opacity: 0, y: 10 }}
								transition={{ duration: 0.3 }}
							>
								<BellIcon className="size-3" />
								<motion.span key={activeText}>{texts[activeText]}</motion.span>
							</motion.div>
						</AnimatePresence>
					</div>
					<DivideX />
					<div className="flex h-full flex-row">
						<div className="h-full w-14 bg-gray-200 dark:bg-neutral-800" />
						<motion.div className="w-full gap-y-4 p-4">
							<h2 className="text-sm font-semibold text-gray-800 dark:text-neutral-300">
								Dashboard
							</h2>

							<div className="mt-4 flex flex-col gap-y-3 mask-b-from-50%">
								{[
									{ label: "Agent runs", width: 85 },
									{ label: "Checks passed", width: 92 },
									{ label: "Open reviews", width: 65 },
								].map((item) => (
									<div key={item.label} className="space-y-1">
										<div className="flex items-center justify-between text-xs">
											<span className="text-muted-foreground">
												{item.label}
											</span>
										</div>
										<div className="h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-neutral-700">
											<div
												style={{ width: `${item.width}%` }}
												className="h-full rounded-full bg-neutral-300 dark:bg-neutral-400"
											/>
										</div>
									</div>
								))}
							</div>
						</motion.div>
					</div>
				</div>
			</div>
		</div>
	);
};

const Card = (props: {
	title: string;
	description: string;
	icon: React.ReactNode;
}) => {
	const { title, description, icon } = props;
	return (
		<div className="bg-card relative z-10 rounded-lg p-4 transition-colors duration-150 hover:bg-transparent md:p-5">
			<div className="flex items-center gap-2">{icon}</div>
			<h3 className="mt-4 mb-2 text-lg font-medium">{title}</h3>
			<p className="text-muted-foreground">{description}</p>
		</div>
	);
};
