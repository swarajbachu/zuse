import {
	IconCheck,
	IconClock,
	IconGitBranch,
	IconSparkles,
} from "@tabler/icons-react";
import Image from "next/image";
import type React from "react";
import { cn } from "@/components/tpl/agenforce/lib/utils";

const WORKTREES = [
	{
		branch: "agent/checkout-recovery",
		agent: "Claude Code",
		src: "/logos/claude.svg",
		detail: "12 files · 16 tests",
		status: "Running",
		tone: "warning" as const,
	},
	{
		branch: "agent/session-race",
		agent: "Codex",
		src: "/logos/openai.svg",
		detail: "PR #814 · 2 comments",
		status: "In review",
		tone: "primary" as const,
	},
	{
		branch: "agent/sidebar-cache",
		agent: "Claude Code",
		src: "/logos/claude.svg",
		detail: "Merged · history kept",
		status: "Cleaned",
		tone: "success" as const,
	},
];

export const SkeletonOne = () => (
	<div className="perspective-distant h-full w-full -translate-y-10 rotate-x-30 -rotate-y-20 rotate-z-15 scale-[1.14] mask-r-from-50% mask-radial-from-50%">
		{WORKTREES.map((item, index) => (
			<WorktreeCard
				key={item.branch}
				{...item}
				className={cn(
					"absolute max-w-[88%]",
					index === 0 && "bottom-0 left-12 z-30",
					index === 1 && "bottom-10 left-8 z-20",
					index === 2 && "bottom-20 left-4 z-10 max-w-[80%]",
				)}
			/>
		))}
	</div>
);

function WorktreeCard({
	branch,
	agent,
	src,
	detail,
	status,
	tone,
	className,
}: (typeof WORKTREES)[number] & { className?: string }) {
	return (
		<div
			className={cn(
				"border-border bg-card mx-auto w-full rounded-2xl border p-3 shadow-2xl",
				className,
			)}
		>
			<div className="flex items-center gap-2">
				<IconGitBranch className="text-muted-foreground size-4 shrink-0" />
				<p className="text-heading min-w-0 flex-1 truncate font-mono text-[11px]">
					{branch}
				</p>
				<Badge tone={tone}>{status}</Badge>
			</div>
			<div className="mt-3 flex items-center gap-2">
				<span className="grid size-6 place-items-center rounded-md bg-white ring-1 ring-black/5">
					<Image src={src} alt="" width={13} height={13} />
				</span>
				<span className="text-heading text-[11px] font-medium">{agent}</span>
				<span className="text-muted-foreground ml-auto font-mono text-[9px]">
					{detail}
				</span>
			</div>
		</div>
	);
}

function Badge({
	tone,
	children,
}: {
	tone: "primary" | "success" | "warning";
	children: React.ReactNode;
}) {
	const Icon =
		tone === "success"
			? IconCheck
			: tone === "warning"
				? IconClock
				: IconSparkles;
	return (
		<span
			className={cn(
				"flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[8px] font-semibold",
				tone === "success" && "border-primary/30 bg-primary/10 text-primary",
				tone === "warning" &&
					"border-amber-400/30 bg-amber-400/10 text-amber-500",
				tone === "primary" && "border-sky-400/30 bg-sky-400/10 text-sky-500",
			)}
		>
			<Icon className="size-2.5" /> {children}
		</span>
	);
}
