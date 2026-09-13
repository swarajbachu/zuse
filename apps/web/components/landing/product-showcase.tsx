"use client";
import { useWebsiteMessages } from "@zuse/i18n/website/react";
import { Features as WorktreeFeatures } from "@/components/tpl/agenforce/components/features";
import { FeaturesSecondary } from "@/components/tpl/agenforce/components/features-secondary";
import { FeaturesTertiary } from "@/components/tpl/agenforce/components/features-tertiary";
import { LogoCloud } from "@/components/tpl/agenforce/components/logo-cloud";
import { HowItWorks } from "@/components/tpl/nodus/components/how-it-works";
import { FeaturesOne } from "@/components/tpl/saas/components/features-one";
import { FeaturesTwo } from "@/components/tpl/saas/components/features-two";
import { WorkflowOverview } from "./workflow-overview";

export function ProductShowcase() {
	const { message: t } = useWebsiteMessages();

	return (
		<div id="features" className="scroll-mt-24">
			<WorkflowOverview />
			<Divider />
			<LogoCloud />
			<Divider />

			<section aria-labelledby="handoff-heading">
				<ShowcaseHeader
					id="handoff-heading"
					eyebrow={t("showcase:agent_handoff")}
					title={t("showcase:continue_the_work_with_another_agent")}
					description={t(
						"showcase:fork_a_session_or_start_a_new_provider_with_the_plan_transcript_and_fi",
					)}
				/>
				<FeaturesSecondary />
			</section>

			<Divider />
			<WorktreeFeatures />
			<Divider />
			<HowItWorks />
			<Divider />

			<section aria-labelledby="review-heading">
				<ShowcaseHeader
					id="review-heading"
					eyebrow={t("showcase:review")}
					title={t("showcase:from_changed_files_to_a_verified_pull_request")}
					description={t(
						"showcase:inspect_the_complete_branch_commit_deliberately_push_when_it_is_ready",
					)}
				/>
				<FeaturesTertiary />
			</section>

			<Divider />
			<FeaturesOne />
			<Divider />
			<div id="cloud" className="scroll-mt-24">
				<FeaturesTwo />
			</div>
		</div>
	);
}

function Divider() {
	return <div aria-hidden="true" className="border-border/60 border-t" />;
}

function ShowcaseHeader({
	id,
	eyebrow,
	title,
	description,
}: {
	id: string;
	eyebrow: string;
	title: string;
	description: string;
}) {
	return (
		<header className="mx-auto max-w-3xl px-5 pt-16 text-center md:pt-24">
			<p className="text-primary font-mono text-[11px] font-semibold uppercase tracking-[0.18em]">
				{eyebrow}
			</p>
			<h2
				id={id}
				className="text-heading mt-3 text-2xl font-semibold tracking-tight text-balance md:text-4xl"
			>
				{title}
			</h2>
			<p className="text-muted-foreground mx-auto mt-4 max-w-2xl text-sm leading-6 text-balance md:text-base md:leading-7">
				{description}
			</p>
		</header>
	);
}
