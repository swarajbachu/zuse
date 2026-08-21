"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/components/tpl/nodus/lib/utils";
import { Badge } from "../badge";
import { Container } from "../container";
import { PixelatedCanvas } from "../pixelated-canvas";
import { SectionHeading } from "../seciton-heading";
import { SubHeading } from "../subheading";
import {
	ContextReviewSkeleton,
	EvidenceTimelineSkeleton,
	SharedWorktreeSkeleton,
} from "./skeletons";

type Tab = {
	title: string;
	description: string;
	icon: React.FC<React.SVGProps<SVGSVGElement>>;
	id: string;
};

export const HowItWorks = () => {
	const tabs = useMemo(
		() => [
			{
				title: "Claude Code · implementation",
				description:
					"Build the change in one tab while every file lands in the shared worktree.",
				icon: FirstIcon,
				id: "implementation",
				skeleton: <SharedWorktreeSkeleton />,
			},
			{
				title: "Codex · diff review",
				description:
					"Review the same branch and transcript in a second tab without copying context.",
				icon: SecondIcon,
				id: "review",
				skeleton: <ContextReviewSkeleton />,
			},
			{
				title: "Checks · terminal",
				description:
					"Keep typecheck, focused tests, and terminal output beside both agent sessions.",
				icon: ThirdIcon,
				id: "checks",
				skeleton: <EvidenceTimelineSkeleton />,
			},
		],
		[],
	);

	const [activeTab, setActiveTab] = useState(tabs[0]);
	const reduceMotion = useReducedMotion();

	const DURATION = 8000;

	useEffect(() => {
		if (reduceMotion) return;
		const interval = setInterval(() => {
			setActiveTab((current) => {
				const currentIndex = tabs.findIndex((tab) => tab.id === current.id);
				return tabs[(currentIndex + 1) % tabs.length];
			});
		}, DURATION);

		return () => clearInterval(interval);
	}, [reduceMotion, tabs]);
	return (
		<Container className="border-divide border-x">
			<div className="flex flex-col items-center pt-16">
				<Badge text="One worktree" />
				<SectionHeading className="mt-4">
					Multiple tabs, shared context
				</SectionHeading>

				<SubHeading as="p" className="mx-auto mt-6 max-w-lg">
					Implementation, review, and checks stay side by side on the same
					branch and working tree.
				</SubHeading>
				{/* Desktop Tabs */}
				<div className="border-divide divide-divide mt-16 hidden w-full grid-cols-2 divide-x border-t lg:grid">
					<div className="divide-divide divide-y">
						{tabs.map((tab) => (
							<button
								type="button"
								key={tab.title}
								className="group relative flex w-full flex-col items-start overflow-hidden px-12 py-8 hover:bg-gray-100 dark:hover:bg-neutral-800"
								onClick={() => setActiveTab(tab)}
							>
								{tab.id === activeTab.id && (
									<Canvas activeTab={tab} duration={2500} />
								)}
								{tab.id === activeTab.id && <Loader duration={DURATION} />}
								<div
									className={cn(
										"text-heading relative z-20 flex items-center gap-2 font-medium",
										activeTab.id !== tab.id && "group-hover:text-brand",
									)}
								>
									<tab.icon className="shrink-0" /> {tab.title}
								</div>
								<p
									className={cn(
										"text-muted-foreground relative z-20 mt-2 text-left text-sm",
										activeTab.id === tab.id && "text-heading",
									)}
								>
									{tab.description}
								</p>
							</button>
						))}
					</div>
					<div className="relative h-full max-h-[370px] overflow-hidden bg-[radial-gradient(var(--color-dots)_1px,transparent_1px)] mask-r-from-90% mask-l-from-90% mask-radial-from-20% [background-size:10px_10px]">
						<AnimatePresence mode="wait">
							<motion.div
								key={activeTab.id}
								className="absolute inset-0"
								initial={{ opacity: 0, y: 8 }}
								animate={{ opacity: 1, y: 0 }}
								exit={{ opacity: 0, y: -8 }}
								transition={{ duration: 0.5 }}
							>
								{activeTab.skeleton}
							</motion.div>
						</AnimatePresence>
					</div>
				</div>
				{/* Mobile Tabs */}
				<div className="divide-divide border-divide mt-16 flex w-full flex-col divide-y overflow-hidden border-t lg:hidden">
					{tabs.map((tab) => (
						<div
							key={`${tab.title}mobile`}
							className="group relative flex w-full flex-col items-start overflow-hidden px-4 py-4 md:px-12 md:py-8"
						>
							<div className="text-heading relative z-20 flex items-center gap-2 font-medium">
								<tab.icon className="shrink-0" /> {tab.title}
							</div>
							<p className="text-muted-foreground relative z-20 mt-2 text-left text-sm">
								{tab.description}
							</p>
							<div className="relative mx-auto h-80 w-full overflow-hidden mask-t-from-90% mask-r-from-90% mask-b-from-90% mask-l-from-90% sm:w-160">
								<div
									className={cn(
										"h-full w-full origin-top sm:scale-100",
										tab.id === "implementation" && "scale-50",
										tab.id === "review" && "scale-[0.68]",
									)}
								>
									{tab.skeleton}
								</div>
							</div>
						</div>
					))}
				</div>
			</div>
		</Container>
	);
};

const Loader = ({ duration = 2500 }: { duration?: number }) => {
	return (
		<motion.div
			className="bg-brand absolute inset-x-0 bottom-0 z-30 h-0.5 w-full rounded-full"
			initial={{ width: 0 }}
			animate={{ width: "100%" }}
			transition={{ duration: duration / 1000 }}
		/>
	);
};

const Canvas = ({
	activeTab,
	duration,
}: {
	activeTab: Tab;
	duration: number;
}) => {
	return (
		<>
			<div className="bg-card absolute inset-x-0 z-20 h-full w-full mask-t-from-50%" />
			<PixelatedCanvas
				key={activeTab.id}
				isActive
				fillColor="var(--color-canvas)"
				backgroundColor="var(--color-canvas-fill)"
				size={2.5}
				duration={duration}
				className="absolute inset-0 scale-[1.01] opacity-20"
			/>
		</>
	);
};

const FirstIcon = (props: React.SVGProps<SVGSVGElement>) => {
	return (
		<svg
			role="presentation"
			aria-hidden="true"
			width="16"
			height="17"
			viewBox="0 0 16 17"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			{...props}
		>
			<path
				d="M8.02287 8.95395C7.99883 8.89366 7.993 8.82765 8.00609 8.76407C8.01918 8.7005 8.05061 8.64216 8.09651 8.59626C8.1424 8.55037 8.20075 8.51893 8.26432 8.50584C8.32789 8.49276 8.39391 8.49859 8.4542 8.52262L14.4542 10.856C14.5185 10.8811 14.5735 10.9256 14.6114 10.9833C14.6493 11.041 14.6684 11.1091 14.666 11.1781C14.6636 11.2471 14.6398 11.3137 14.5979 11.3686C14.556 11.4235 14.4981 11.464 14.4322 11.4846L12.1362 12.1966C12.0326 12.2286 11.9384 12.2855 11.8617 12.3621C11.785 12.4388 11.7282 12.533 11.6962 12.6366L10.9849 14.932C10.9643 14.9979 10.9237 15.0558 10.8688 15.0977C10.8139 15.1396 10.7474 15.1634 10.6783 15.1658C10.6093 15.1682 10.5412 15.1491 10.4835 15.1112C10.4258 15.0732 10.3813 15.0183 10.3562 14.954L8.02287 8.95395Z"
				stroke="currentColor"
				strokeWidth="1.33333"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path
				d="M14 7.83333V3.83333C14 3.47971 13.8595 3.14057 13.6095 2.89052C13.3594 2.64048 13.0203 2.5 12.6667 2.5H3.33333C2.97971 2.5 2.64057 2.64048 2.39052 2.89052C2.14048 3.14057 2 3.47971 2 3.83333V13.1667C2 13.5203 2.14048 13.8594 2.39052 14.1095C2.64057 14.3595 2.97971 14.5 3.33333 14.5H7.33333"
				stroke="currentColor"
				strokeWidth="1.33333"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
};

export const SecondIcon = (props: React.SVGProps<SVGSVGElement>) => {
	return (
		<svg
			role="presentation"
			aria-hidden="true"
			width="16"
			height="17"
			viewBox="0 0 16 17"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			{...props}
		>
			<path
				d="M8 12.5V3.83337"
				stroke="currentColor"
				strokeWidth="1.33333"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path
				d="M10 9.16667C9.4232 8.99806 8.91656 8.64708 8.556 8.16633C8.19544 7.68558 8.00036 7.10094 8 6.5C7.99964 7.10094 7.80456 7.68558 7.444 8.16633C7.08344 8.64708 6.5768 8.99806 6 9.16667"
				stroke="currentColor"
				strokeWidth="1.33333"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path
				d="M11.732 4.83322C11.8854 4.56754 11.9756 4.27014 11.9957 3.96401C12.0158 3.65789 11.9652 3.35125 11.8478 3.06781C11.7304 2.78438 11.5494 2.53175 11.3187 2.32947C11.0881 2.12719 10.814 1.98068 10.5176 1.90128C10.2213 1.82188 9.91069 1.81171 9.6098 1.87156C9.30891 1.93142 9.02583 2.05969 8.78244 2.24645C8.53906 2.43321 8.3419 2.67346 8.20623 2.94861C8.07055 3.22376 7.99999 3.52643 8 3.83322C8.00001 3.52643 7.92945 3.22376 7.79377 2.94861C7.6581 2.67346 7.46094 2.43321 7.21756 2.24645C6.97417 2.05969 6.69109 1.93142 6.3902 1.87156C6.08931 1.81171 5.77868 1.82188 5.48236 1.90128C5.18603 1.98068 4.91193 2.12719 4.68129 2.32947C4.45064 2.53175 4.26961 2.78438 4.15222 3.06781C4.03483 3.35125 3.98421 3.65789 4.00429 3.96401C4.02436 4.27014 4.11459 4.56754 4.268 4.83322"
				stroke="currentColor"
				strokeWidth="1.33333"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path
				d="M11.998 3.91663C12.3899 4.01738 12.7537 4.20599 13.0619 4.46817C13.3701 4.73034 13.6146 5.05921 13.7768 5.42986C13.9391 5.80051 14.0149 6.20322 13.9985 6.6075C13.982 7.01178 13.8738 7.40702 13.682 7.76329"
				stroke="currentColor"
				strokeWidth="1.33333"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path
				d="M12 12.4999C12.587 12.4999 13.1576 12.3062 13.6233 11.9488C14.089 11.5915 14.4238 11.0905 14.5757 10.5235C14.7276 9.95645 14.6882 9.35516 14.4636 8.81284C14.239 8.27051 13.8417 7.81745 13.3333 7.52393"
				stroke="currentColor"
				strokeWidth="1.33333"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path
				d="M13.3114 12.1553C13.3581 12.5168 13.3303 12.884 13.2295 13.2343C13.1287 13.5846 12.9572 13.9105 12.7256 14.1919C12.4939 14.4733 12.207 14.7043 11.8826 14.8704C11.5582 15.0366 11.2032 15.1346 10.8394 15.1582C10.4757 15.1818 10.111 15.1306 9.76782 15.0077C9.42466 14.8848 9.11033 14.6929 8.84424 14.4438C8.57815 14.1947 8.36596 13.8937 8.22077 13.5593C8.07558 13.225 8.00047 12.8644 8.00008 12.4999C7.99969 12.8644 7.92458 13.225 7.77939 13.5593C7.6342 13.8937 7.42201 14.1947 7.15592 14.4438C6.88983 14.6929 6.5755 14.8848 6.23234 15.0077C5.88917 15.1306 5.52446 15.1818 5.16073 15.1582C4.797 15.1346 4.44197 15.0366 4.11756 14.8704C3.79315 14.7043 3.50626 14.4733 3.2746 14.1919C3.04294 13.9105 2.87144 13.5846 2.77067 13.2343C2.66991 12.884 2.64202 12.5168 2.68875 12.1553"
				stroke="currentColor"
				strokeWidth="1.33333"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path
				d="M3.9998 12.4999C3.4128 12.4999 2.84221 12.3062 2.37651 11.9488C1.91082 11.5915 1.57605 11.0905 1.42412 10.5235C1.27219 9.95645 1.31159 9.35516 1.53621 8.81284C1.76083 8.27051 2.15812 7.81745 2.66647 7.52393"
				stroke="currentColor"
				strokeWidth="1.33333"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path
				d="M4.00187 3.91663C3.61001 4.01738 3.24621 4.20599 2.93803 4.46817C2.62985 4.73034 2.38536 5.05921 2.2231 5.42986C2.06084 5.80051 1.98504 6.20322 2.00146 6.6075C2.01788 7.01178 2.12608 7.40702 2.31787 7.76329"
				stroke="currentColor"
				strokeWidth="1.33333"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
};

export const ThirdIcon = (props: React.SVGProps<SVGSVGElement>) => {
	return (
		<svg
			role="presentation"
			aria-hidden="true"
			width="16"
			height="17"
			viewBox="0 0 16 17"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			{...props}
		>
			<path
				d="M10.6667 9.16664L14.1487 11.488C14.1989 11.5214 14.2573 11.5405 14.3175 11.5434C14.3777 11.5463 14.4376 11.5328 14.4907 11.5043C14.5439 11.4759 14.5883 11.4335 14.6193 11.3818C14.6503 11.3301 14.6667 11.2709 14.6667 11.2106V5.74664C14.6668 5.68799 14.6513 5.63037 14.6219 5.57961C14.5926 5.52884 14.5503 5.48672 14.4995 5.45751C14.4486 5.42829 14.3909 5.41301 14.3323 5.41321C14.2736 5.41341 14.2161 5.42908 14.1654 5.45864L10.6667 7.49997"
				stroke="currentColor"
				strokeWidth="1.33333"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path
				d="M9.33325 4.5H2.66659C1.93021 4.5 1.33325 5.09695 1.33325 5.83333V11.1667C1.33325 11.903 1.93021 12.5 2.66659 12.5H9.33325C10.0696 12.5 10.6666 11.903 10.6666 11.1667V5.83333C10.6666 5.09695 10.0696 4.5 9.33325 4.5Z"
				stroke="currentColor"
				strokeWidth="1.33333"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
};
