"use client";
import { useWebsiteMessages } from "@zuse/i18n/website/react";
import type React from "react";
import { IllustrationBackground } from "@/components/landing/illustration-background";
import { Container } from "@/components/tpl/agenforce/components/container";
import { cn } from "@/components/tpl/agenforce/lib/utils";
import { SkeletonOne } from "./skeletons/first";
import { SkeletonTwo } from "./skeletons/second";

export const FeaturesSecondary = () => {
	const { message: t } = useWebsiteMessages();

	return (
		<section id="handoff" className="relative overflow-hidden pt-10 md:pt-12">
			<Container className="px-0 md:px-0">
				<div className="border-border/60 divide-border/60 grid grid-cols-1 border-y divide-y md:grid-cols-2 md:divide-x md:divide-y-0">
					<div>
						<CardContent>
							<h3 className="text-heading text-2xl">
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
							<h3 className="text-heading text-2xl">
								{t("showcase:fork_when_a_provider_hits_its_limit")}
							</h3>
							<CardDescription>
								{t(
									"showcase:fork_the_session_to_another_provider_and_carry_forward_a_copied_transc",
								)}
							</CardDescription>
						</CardContent>
						<CardSkeleton>
							<SkeletonTwo />
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
		<p className="landing-prose text-muted-foreground mt-2 max-w-md text-balance">
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
				"relative isolate h-80 sm:h-60 flex flex-col md:h-80 overflow-hidden perspective-distant",
				className,
			)}
		>
			<IllustrationBackground />
			{children}
		</div>
	);
};
