"use client";
import { useWebsiteMessages } from "@zuse/i18n/website/react";
import type React from "react";
import { Container } from "@/components/tpl/agenforce/components/container";
import { cn } from "@/components/tpl/agenforce/lib/utils";
import { SkeletonOne } from "./skeletons/first";
import { SkeletonFour } from "./skeletons/four";
import { SkeletonTwo } from "./skeletons/second";
import { SkeletonThree } from "./skeletons/third";

export const FeaturesTertiary = () => {
	const { message: t } = useWebsiteMessages();

	return (
		<section className="pt-10 md:pt-20 lg:py-32 relative overflow-hidden">
			<Container>
				<div className="grid grid-cols-1 md:grid-cols-2 border-y border-neutral-200 dark:border-neutral-800  divide-neutral-200 dark:divide-neutral-800">
					<div className="md:border-r border-b border-neutral-200 dark:border-neutral-800">
						<CardContent>
							<h3 className="text-lg font-bold text-neutral-800 dark:text-neutral-200">
								{t("showcase:review_every_changed_file")}
							</h3>
							<CardDescription>
								{t(
									"showcase:see_the_branch_diff_changed_files_and_line_totals_before_anything_leav",
								)}
							</CardDescription>
						</CardContent>
						<CardSkeleton>
							<SkeletonOne />
						</CardSkeleton>
					</div>
					<div className="border-b border-neutral-200 dark:border-neutral-800">
						<CardContent>
							<h3 className="text-lg font-bold text-neutral-800 dark:text-neutral-200">
								{t("showcase:inline_diff_review_before_push")}
							</h3>
							<CardDescription>
								{t(
									"showcase:review_additions_deletions_files_and_agent_findings_without_leaving_zu",
								)}
							</CardDescription>
						</CardContent>
						<CardSkeleton className="mask-radial-from-20% ">
							<SkeletonTwo />
						</CardSkeleton>
					</div>
					<div className="md:border-r border-neutral-200 dark:border-neutral-800">
						<CardContent>
							<h3 className="text-lg font-bold text-neutral-800 dark:text-neutral-200">
								{t("showcase:commit_selected_files_push")}
							</h3>
							<CardDescription>
								{t(
									"showcase:choose_exactly_which_files_enter_the_commit_write_the_message_and_push",
								)}
							</CardDescription>
						</CardContent>
						<CardSkeleton className="mask-radial-from-20%  mask-r-from-50%">
							<SkeletonThree />
						</CardSkeleton>
					</div>
					<div className=" dark:border-neutral-800">
						<CardContent>
							<h3 className="text-lg font-bold text-neutral-800 dark:text-neutral-200">
								{t("showcase:send_failing_checks_to_the_agent")}
							</h3>
							<CardDescription>
								{t(
									"showcase:collect_failed_github_actions_logs_and_attach_them_to_the_agent_thread",
								)}
							</CardDescription>
						</CardContent>
						<CardSkeleton className="">
							<SkeletonFour />
						</CardSkeleton>
					</div>
				</div>
			</Container>
		</section>
	);
};

export const CardContent = ({ children }: { children: React.ReactNode }) => {
	return <div className="p-4 md:p-8">{children}</div>;
};

export const CardDescription = ({
	children,
}: {
	children: React.ReactNode;
}) => {
	return (
		<p className="text-neutral-600 dark:text-neutral-400 mt-2 max-w-md text-balance">
			{children}
		</p>
	);
};

export const CardSkeleton = ({
	className,
	children,
}: {
	className?: string;
	children?: React.ReactNode;
}) => {
	return (
		<div
			className={cn(
				"relative h-80 sm:h-60 flex flex-col md:h-80 overflow-hidden perspective-distant",
				className,
			)}
		>
			{children}
		</div>
	);
};
