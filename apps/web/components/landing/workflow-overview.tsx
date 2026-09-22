"use client";
import { useWebsiteMessages } from "@zuse/i18n/website/react";
import Image from "next/image";

export function WorkflowOverview() {
	const { message: t } = useWebsiteMessages();
	const steps = [
		{ image: "pegasus", title: t("showcase:bring_the_agents_you_already_use") },
		{ image: "observatory", title: t("showcase:run_work_in_parallel") },
		{ image: "handoff", title: t("showcase:carry_context_then_review") },
	];
	return (
		<section id="workflow" className="scroll-mt-24 px-4 py-16 md:px-8 md:py-20">
			<header className="mx-auto max-w-3xl text-center">
				<p className="text-primary font-mono text-[11px] uppercase tracking-[0.18em]">
					{t("showcase:how_zuse_works")}
				</p>
				<h2 className="text-heading mt-4 text-4xl text-balance md:text-6xl">
					{t("showcase:one_repo_many_agents_no_lost_context")}
				</h2>
			</header>
			<ol className="mt-10 grid gap-8 md:grid-cols-3 md:gap-5">
				{steps.map((step, index) => (
					<li key={step.image}>
						<div className="overflow-hidden rounded-xl bg-[#11251b]">
							<Image
								src={`/brand/${step.image}-dither.webp`}
								alt=""
								width={1000}
								height={1000}
								sizes="(max-width: 767px) 90vw, 360px"
								className="aspect-[1.12] w-full object-cover"
							/>
						</div>
						<div className="mt-5 flex items-start gap-3">
							<span className="text-primary/70 pt-1.5 font-mono text-[10px]">
								0{index + 1}
							</span>
							<h3 className="text-heading text-3xl leading-tight">
								{step.title}
							</h3>
						</div>
					</li>
				))}
			</ol>
		</section>
	);
}
