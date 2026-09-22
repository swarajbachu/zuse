"use client";
import {
	useWebsiteMessages,
	WebsiteRichMessage,
} from "@zuse/i18n/website/react";
import { Container } from "../container";
import { Heading } from "../heading";

import { Card, CardContent, CardSkeleton, CardTitle } from "./card";
import { SkeletonOne } from "./skeletons/first";
import { SkeletonTwo } from "./skeletons/second";
import { SkeletonThree } from "./skeletons/third";

export const Features = () => {
	const { message: t } = useWebsiteMessages();

	return (
		<Container className="py-12 md:py-20">
			<div
				id="worktrees"
				className="flex xl:flex-row flex-col xl:items-baseline-last justify-between gap-10"
			>
				<Heading className="text-center lg:text-left">
					<WebsiteRichMessage
						id="showcase:parallel_work_without_branch_chaos"
						values={{}}
						components={{ part0: <br /> }}
					/>
				</Heading>
			</div>
			<div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mt-10">
				<Card>
					<CardSkeleton>
						<SkeletonOne />
					</CardSkeleton>
					<CardContent>
						<CardTitle>{t("showcase:every_run_stays_isolated")}</CardTitle>
					</CardContent>
				</Card>
				<Card>
					<CardSkeleton>
						<SkeletonTwo />
					</CardSkeleton>
					<CardContent>
						<CardTitle>{t("showcase:hand_off_the_complete_context")}</CardTitle>
					</CardContent>
				</Card>
				<Card>
					<CardSkeleton>
						<SkeletonThree />
					</CardSkeleton>
					<CardContent>
						<CardTitle>
							{t("showcase:reclaim_disk_without_losing_work")}
						</CardTitle>
					</CardContent>
				</Card>
			</div>
		</Container>
	);
};
