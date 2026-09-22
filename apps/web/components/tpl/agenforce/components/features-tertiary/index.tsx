"use client";
import { useWebsiteMessages } from "@zuse/i18n/website/react";
import type React from "react";
import { IllustrationBackground } from "@/components/landing/illustration-background";
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
			<Container className="px-0 md:px-0">
				<div className="grid grid-cols-1 md:grid-cols-2 border-y border-border/60  divide-border/60">
					<div className="md:border-r border-b border-border/60">
						<CardContent>
							<h3 className="text-3xl text-heading">
								{t("showcase:review_every_changed_file")}
							</h3>
						</CardContent>
						<CardSkeleton>
							<SkeletonOne />
						</CardSkeleton>
					</div>
					<div className="border-b border-border/60">
						<CardContent>
							<h3 className="text-3xl text-heading">
								{t("showcase:inline_diff_review_before_push")}
							</h3>
						</CardContent>
						<CardSkeleton className="mask-radial-from-20% ">
							<SkeletonTwo />
						</CardSkeleton>
					</div>
					<div className="md:border-r border-border/60">
						<CardContent>
							<h3 className="text-3xl text-heading">
								{t("showcase:commit_selected_files_push")}
							</h3>
						</CardContent>
						<CardSkeleton className="mask-radial-from-20%  mask-r-from-50%">
							<SkeletonThree />
						</CardSkeleton>
					</div>
					<div className=" dark:border-neutral-800">
						<CardContent>
							<h3 className="text-3xl text-heading">
								{t("showcase:send_failing_checks_to_the_agent")}
							</h3>
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
				"relative isolate h-80 sm:h-60 flex flex-col md:h-80 overflow-hidden perspective-distant",
				className,
			)}
		>
			<IllustrationBackground />
			{children}
		</div>
	);
};
