"use client";

import { Button as DownloadButton } from "@/components/button";
import { ZuseInteractiveDemo } from "@/components/demo/zuse-interactive-demo";
import { HorizontalLine } from "./line";

export const Hero = () => {
	return (
		<section className="overflow-hidden pt-32 md:pt-40">
			<div className="relative flex flex-col items-center px-4 text-center md:px-8">
				<span className="border-primary/30 bg-primary/10 text-primary flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium">
					<span className="bg-primary size-1.5 rounded-full" />
					Open source · Cloud beta live
				</span>
				<h1 className="text-heading mt-5 max-w-[18ch] font-display text-4xl font-semibold leading-[1.04] tracking-tight text-balance md:text-6xl lg:text-7xl">
					Run every coding agent from{" "}
					<span className="text-primary">one desktop</span>
				</h1>
				<p className="text-muted-foreground mt-6 max-w-[58ch] text-base leading-7 text-pretty md:text-lg">
					The open-source autonomous coding workspace for local and cloud
					agents. Give it an issue—Zuse plans, codes, tests, and prepares the
					pull request with the subscriptions you already pay for.
				</p>
				<div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
					<DownloadButton />
				</div>
				<p className="text-muted-foreground mt-3 text-xs">
					Free in beta · no token markup
				</p>
			</div>

			<div className="border-border relative mx-3 mt-12 overflow-hidden rounded-xl border bg-background shadow-2xl shadow-black/20 md:mx-6 md:mt-16">
				<ZuseInteractiveDemo embedded />
			</div>
			<HorizontalLine className="mt-10 mask-x-from-98% md:mt-16" />
		</section>
	);
};
