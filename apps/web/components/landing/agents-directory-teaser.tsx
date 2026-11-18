"use client";
import { useWebsiteMessages } from "@zuse/i18n/website/react";
import { Button } from "@/components/button";
import { CLOUD_AGENTS_DIRECTORY_PATH } from "@/lib/site";

/** Home page entry point to the cloud coding agents directory. */
export function AgentsDirectoryTeaser({ count }: { count: number }) {
	const { message: t, locale } = useWebsiteMessages();

	return (
		<section aria-labelledby="agents-directory-heading">
			<header className="mx-auto max-w-3xl px-5 py-16 text-center md:py-24">
				<p className="text-primary font-mono text-[11px] font-semibold uppercase tracking-[0.18em]">
					{t("landing:agents_directory_eyebrow")}
				</p>
				<h2
					id="agents-directory-heading"
					className="text-heading mt-3 text-4xl tracking-tight text-balance md:text-6xl"
				>
					{t("landing:agents_directory_title")}
				</h2>
				<p className="landing-prose text-muted-foreground mx-auto mt-5 max-w-[58ch] text-base leading-7 text-pretty md:text-lg">
					{t("landing:agents_directory_body", {
						value0: count.toLocaleString(locale),
					})}
				</p>
				<div className="mt-8 flex justify-center">
					<Button
						href={CLOUD_AGENTS_DIRECTORY_PATH}
						text={t("landing:agents_directory_cta")}
						showIcon={false}
					/>
				</div>
			</header>
		</section>
	);
}
