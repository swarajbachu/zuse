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
								Plan with one model, continue with another
							</h3>
							<CardDescription>
								Start another provider session for implementation and attach the
								plan, transcript, or files it needs.
							</CardDescription>
						</CardContent>
						<CardSkeleton>
							<SkeletonOne />
						</CardSkeleton>
					</div>
					<div>
						<CardContent>
							<h3 className="text-heading text-lg font-bold">
								Fork when a provider hits its limit
							</h3>
							<CardDescription>
								Fork the session to another provider and carry forward a copied
								transcript or explicit handoff context.
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
								Pick a model per step
							</h3>
						</div>

						<p className="text-muted-foreground mt-2 text-base">
							Choose which agent handles planning, coding, and review — per
							task, not per project.
						</p>
					</div>
					<div>
						<div className="flex items-center gap-2">
							<IntegrationIcon />
							<h3 className="text-heading text-lg font-bold">
								Attach the right context
							</h3>
						</div>

						<p className="text-muted-foreground mt-2 text-base">
							Add a plan, transcript, diff, or focused files when starting the
							next session.
						</p>
					</div>
					<div>
						<div className="flex items-center gap-2">
							<HumanIcon />
							<h3 className="text-heading text-lg font-bold">
								You stay in control
							</h3>
						</div>

						<p className="text-muted-foreground mt-2 text-base">
							Choose the provider and model for each session, then decide what
							context to carry forward.
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
