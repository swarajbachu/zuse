import { Features as WorktreeFeatures } from "@/components/tpl/agenforce/components/features";
import { FeaturesSecondary } from "@/components/tpl/agenforce/components/features-secondary";
import { FeaturesTertiary } from "@/components/tpl/agenforce/components/features-tertiary";
import { LogoCloud } from "@/components/tpl/agenforce/components/logo-cloud";
import { HowItWorks } from "@/components/tpl/nodus/components/how-it-works";
import { FeaturesOne } from "@/components/tpl/saas/components/features-one";
import { FeaturesTwo } from "@/components/tpl/saas/components/features-two";
import { WorkflowOverview } from "./workflow-overview";

export function ProductShowcase() {
	return (
		<div id="features" className="scroll-mt-24">
			<WorkflowOverview />
			<Divider />
			<LogoCloud />
			<Divider />

			<section aria-labelledby="handoff-heading">
				<ShowcaseHeader
					id="handoff-heading"
					eyebrow="Agent handoff"
					title="Continue the work with another agent"
					description="Fork a session or start a new provider with the plan, transcript, and files it needs. You choose what moves forward."
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
					eyebrow="Review"
					title="From changed files to a verified pull request"
					description="Inspect the complete branch, commit deliberately, push when it is ready, and send failed checks back to the active agent."
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
