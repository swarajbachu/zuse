import { Container } from "../container";
import { Heading } from "../heading";
import { Subheading } from "../subheading";
import { Card, CardContent, CardSkeleton, CardTitle } from "./card";
import { SkeletonOne } from "./skeletons/first";
import { SkeletonTwo } from "./skeletons/second";
import { SkeletonThree } from "./skeletons/third";

export const Features = () => {
	return (
		<Container className="py-10 md:py-20 lg:py-32">
			<div
				id="worktrees"
				className="flex xl:flex-row flex-col xl:items-baseline-last justify-between gap-10"
			>
				<Heading className="text-center lg:text-left">
					The best worktree <br /> management, anywhere.
				</Heading>
				<Subheading className="text-center lg:text-left mx-auto lg:mx-0">
					Every run gets an isolated branch and working tree. See its agent,
					files, tests, review state, handoff evidence, and cleanup status.
				</Subheading>
			</div>
			<div className="grid grid-cols-1 lg:grid-cols-3 gap-4 my-10 md:my-20">
				<Card className="rounded-tl-3xl rounded-bl-3xl">
					<CardSkeleton>
						<SkeletonOne />
					</CardSkeleton>
					<CardContent>
						<CardTitle>Every run stays isolated</CardTitle>
					</CardContent>
				</Card>
				<Card>
					<CardSkeleton>
						<SkeletonTwo />
					</CardSkeleton>
					<CardContent>
						<CardTitle>Hand off the complete context</CardTitle>
					</CardContent>
				</Card>
				<Card className="rounded-tr-3xl rounded-br-3xl">
					<CardSkeleton>
						<SkeletonThree />
					</CardSkeleton>
					<CardContent>
						<CardTitle>Reclaim disk without losing work</CardTitle>
					</CardContent>
				</Card>
			</div>
		</Container>
	);
};
