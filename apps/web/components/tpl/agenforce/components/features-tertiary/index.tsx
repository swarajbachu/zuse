import type React from "react";
import { Container } from "@/components/tpl/agenforce/components/container";
import { cn } from "@/components/tpl/agenforce/lib/utils";
import { SkeletonOne } from "./skeletons/first";
import { SkeletonFour } from "./skeletons/four";
import { SkeletonTwo } from "./skeletons/second";
import { SkeletonThree } from "./skeletons/third";

export const FeaturesTertiary = () => {
	return (
		<section className="pt-10 md:pt-20 lg:py-32 relative overflow-hidden">
			<Container>
				<div className="grid grid-cols-1 md:grid-cols-2 border-y border-neutral-200 dark:border-neutral-800  divide-neutral-200 dark:divide-neutral-800">
					<div className="md:border-r border-b border-neutral-200 dark:border-neutral-800">
						<CardContent>
							<h3 className="text-lg font-bold text-neutral-800 dark:text-neutral-200">
								Review every changed file
							</h3>
							<CardDescription>
								See the branch diff, changed files, and line totals before
								anything leaves your machine.
							</CardDescription>
						</CardContent>
						<CardSkeleton>
							<SkeletonOne />
						</CardSkeleton>
					</div>
					<div className="border-b border-neutral-200 dark:border-neutral-800">
						<CardContent>
							<h3 className="text-lg font-bold text-neutral-800 dark:text-neutral-200">
								Inline diff review before push
							</h3>
							<CardDescription>
								Review additions, deletions, files, and agent findings without
								leaving Zuse.
							</CardDescription>
						</CardContent>
						<CardSkeleton className="mask-radial-from-20% ">
							<SkeletonTwo />
						</CardSkeleton>
					</div>
					<div className="md:border-r border-neutral-200 dark:border-neutral-800">
						<CardContent>
							<h3 className="text-lg font-bold text-neutral-800 dark:text-neutral-200">
								Commit selected files &amp; push
							</h3>
							<CardDescription>
								Choose exactly which files enter the commit, write the message,
								and push the branch when it is ready.
							</CardDescription>
						</CardContent>
						<CardSkeleton className="mask-radial-from-20%  mask-r-from-50%">
							<SkeletonThree />
						</CardSkeleton>
					</div>
					<div className=" dark:border-neutral-800">
						<CardContent>
							<h3 className="text-lg font-bold text-neutral-800 dark:text-neutral-200">
								Send failing checks to the agent
							</h3>
							<CardDescription>
								Collect failed GitHub Actions logs and attach them to the agent
								thread so it can diagnose and fix the branch.
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
