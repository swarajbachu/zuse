"use client";
import {
	useWebsiteMessages,
	WebsiteRichMessage,
} from "@zuse/i18n/website/react";
import Link from "next/link";
import { Button as DownloadButton } from "@/components/button";
import { ZuseInteractiveDemo } from "@/components/demo/zuse-interactive-demo";
import { HorizontalLine } from "./line";

export const Hero = () => {
	const { message: t } = useWebsiteMessages();

	return (
		<section data-landing-hero className="overflow-hidden pt-32 md:pt-40">
			<div className="relative flex flex-col items-center px-4 text-center md:px-8">
				<h1 className="text-heading mt-5 w-full max-w-[24ch] break-words hyphens-auto font-display text-[2.5rem] font-light leading-[1.04] tracking-tight text-balance md:text-[4rem] lg:text-[5rem]">
					<WebsiteRichMessage
						id="landing:cloud_coding_agents_open_source"
						values={{}}
						components={{
							part0: <span className="heading-accent text-primary block" />,
						}}
					/>
				</h1>
				<p className="landing-prose text-muted-foreground mt-6 max-w-[58ch] text-base leading-7 text-pretty md:text-lg">
					{t("landing:open_source_devin_alternative")}
				</p>
				<div className="mt-8 flex flex-col items-center gap-4 sm:flex-row">
					<DownloadButton />
					<Link
						href="#workflow"
						className="text-heading focus-visible:ring-heading/60 inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium underline decoration-border underline-offset-4 transition-colors duration-200 hover:decoration-primary focus-visible:ring-2 focus-visible:outline-none"
					>
						{t("landing:see_how_it_works")}
					</Link>
				</div>
				<p className="text-muted-foreground mt-3 text-xs">
					{t("landing:free_in_beta_no_token_markup")}
				</p>
			</div>

			<div className="border-border relative mx-3 mt-12 overflow-hidden rounded-xl border bg-background shadow-2xl shadow-black/20 md:mx-6 md:mt-16">
				<ZuseInteractiveDemo embedded />
			</div>
			<HorizontalLine className="mt-10 mask-x-from-98% md:mt-16" />
		</section>
	);
};
