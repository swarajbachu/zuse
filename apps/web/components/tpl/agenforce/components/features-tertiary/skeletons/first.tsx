"use client";
import {
	IconCheck,
	IconFileDiff,
	IconFiles,
	IconGitBranch,
	IconListCheck,
} from "@tabler/icons-react";
import {
	useWebsiteMessages,
	type WebsiteMessage,
} from "@zuse/i18n/website/react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/components/tpl/agenforce/lib/utils";

const getACTIVITY = (t: WebsiteMessage) =>
	[
		{
			icon: IconGitBranch,
			title: t("showcase:branch"),
			detail: "agent/checkout-recovery",
			badge: t("showcase:4_commits"),
		},
		{
			icon: IconFiles,
			title: t("showcase:changed_files"),
			detail: "9 modified · 2 added · 1 deleted",
			badge: t("showcase:12_files"),
		},
		{
			icon: IconFileDiff,
			title: t("showcase:branch_diff"),
			detail: "+182 additions · −47 deletions",
			badge: t("showcase:diff_2"),
		},
		{
			icon: IconListCheck,
			title: t("showcase:uncommitted_work"),
			detail: "3 files ready to review",
			badge: t("showcase:local"),
		},
		{
			icon: IconCheck,
			title: t("showcase:review_range_ready"),
			detail: "Compared with origin/main",
			badge: t("showcase:ready"),
		},
	] as const;

export const SkeletonOne = () => {
	const { message: t } = useWebsiteMessages();

	const reduceMotion = useReducedMotion();
	return (
		<div className="border-border bg-elevated absolute inset-x-10 inset-y-2 mx-auto flex h-full w-full flex-1 flex-col gap-2 rounded-t-3xl border px-2 pt-2">
			<div className="bg-card ring-border/70 flex flex-1 flex-col items-start gap-3 rounded-tl-2xl ring-1 shadow-lg shadow-black/5">
				<div className="border-border flex w-full items-center gap-2 border-b px-4 py-2">
					<IconFileDiff className="text-primary size-4" />
					<p className="text-heading text-sm font-bold">
						{t("showcase:branch_review")}
					</p>
				</div>
				{getACTIVITY(t).map((item, index) => (
					<motion.div
						key={item.title}
						initial={false}
						whileInView={{ opacity: 1, y: 0 }}
						transition={{
							duration: 0.24,
							delay: reduceMotion ? 0 : index * 0.07,
						}}
						className="flex w-full items-center gap-2 overflow-hidden px-4"
					>
						<span className="bg-primary/15 grid size-5 shrink-0 place-items-center rounded-md">
							<item.icon className="text-primary size-3" />
						</span>
						<div className="min-w-0 flex-1">
							<p className="text-heading truncate text-xs font-medium">
								{item.title}
							</p>
							<p className="text-muted-foreground truncate font-mono text-[9px]">
								{item.detail}
							</p>
						</div>
						<span
							className={cn(
								"border-primary/30 bg-primary/10 text-primary rounded-md border px-1.5 py-0.5 font-mono text-[8px] font-bold",
							)}
						>
							{item.badge}
						</span>
					</motion.div>
				))}
			</div>
		</div>
	);
};
