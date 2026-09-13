"use client";
import { useWebsiteMessages } from "@zuse/i18n/website/react";
import type React from "react";
import { Container } from "@/components/tpl/agenforce/components/container";
import {
	HumanIcon,
	IntegrationIcon,
	WorkflowIcon,
} from "@/components/tpl/agenforce/icons";
import { cn } from "@/components/tpl/agenforce/lib/utils";
import { SkeletonOne } from "./skeletons/first";
import { SkeletonTwo } from "./skeletons/second";

export const FeaturesSecondary = () => {
	const { message: t } = useWebsiteMessages();

	return (
		<section
			id="handoff"
			className="pt-10 md:pt-20 lg:py-32 relative overflow-hidden"
		>
			<Container>
				<div className="border-border grid grid-cols-1 border-y divide-y md:grid-cols-2 md:divide-x md:divide-y-0">
					<div>
						<CardContent>
							<h3 className="text-heading text-lg font-bold">
								{t("showcase:plan_with_one_model_continue_with_another")}
							</h3>
							<CardDescription>
								{t(
									"showcase:start_another_provider_session_for_implementation_and_attach_the_plan",
								)}
							</CardDescription>
						</CardContent>
						<CardSkeleton>
							<SkeletonOne />
						</CardSkeleton>
					</div>
					<div>
						<CardContent>
							<h3 className="text-heading text-lg font-bold">
								{t("showcase:fork_when_a_provider_hits_its_limit")}
							</h3>
							<CardDescription>
								{t(
									"showcase:fork_the_session_to_another_provider_and_carry_forward_a_copied_transc",
								)}
							</CardDescription>
						</CardContent>
						<CardSkeleton className="mask-radial-from-50% mask-t-from-50%">
							<SkeletonTwo />
						</CardSkeleton>
					</div>
				</div>

				<div className="mt-10 grid grid-cols-1 gap-10 md:mt-20 md:grid-cols-3">
					<div>
						<div className="flex items-center gap-2">
							<WorkflowIcon />
							<h3 className="text-heading text-lg font-bold">
								{t("showcase:pick_a_model_per_step")}
							</h3>
						</div>

						<p className="text-muted-foreground mt-2 text-base">
							{t(
								"showcase:choose_which_agent_handles_planning_coding_and_review_per_task_not_per",
							)}
						</p>
					</div>
					<div>
						<div className="flex items-center gap-2">
							<IntegrationIcon />
							<h3 className="text-heading text-lg font-bold">
								{t("showcase:attach_the_right_context")}
							</h3>
						</div>

						<p className="text-muted-foreground mt-2 text-base">
							{t(
								"showcase:add_a_plan_transcript_diff_or_focused_files_when_starting_the_next_ses",
							)}
						</p>
					</div>
					<div>
						<div className="flex items-center gap-2">
							<HumanIcon />
							<h3 className="text-heading text-lg font-bold">
								{t("showcase:you_stay_in_control")}
							</h3>
						</div>

						<p className="text-muted-foreground mt-2 text-base">
							{t(
								"showcase:choose_the_provider_and_model_for_each_session_then_decide_what_contex",
							)}
						</p>
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
		<p className="text-muted-foreground mt-2 max-w-md text-balance">
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
