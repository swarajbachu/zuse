"use client";
import {
	IconBrandDiscord,
	IconBrandGithub,
	IconBrandInstagram,
} from "@tabler/icons-react";

import {
	useWebsiteMessages,
	type WebsiteMessage,
} from "@zuse/i18n/website/react";
import type { WebsiteMessageKey } from "@zuse/i18n/website/types";
import Link from "next/link";
import { Button } from "@/components/button";
import { Container } from "@/components/container";
import { CopyRightIcon, XformerlyTwitter } from "@/components/icons/general";
import { Logo } from "@/components/logo";
import { legalPageLinks } from "@/lib/legal-pages";
import {
	DISCORD_URL,
	DOWNLOAD_URL,
	GITHUB_URL,
	INSTAGRAM_URL,
	RELEASES_URL,
	X_URL,
} from "@/lib/site";

// Every link here must resolve. No placeholder hrefs — pages get linked when
// they exist.
const legalLabels: Record<string, WebsiteMessageKey> = {
	"/privacy": "navigation:privacy",
	"/terms": "navigation:terms",
	"/cookies": "navigation:cookies",
	"/acceptable-use": "navigation:acceptable_use",
	"/security": "navigation:security",
	"/data-rights": "navigation:data_rights",
	"/subprocessors": "navigation:subprocessors",
	"/accessibility": "navigation:accessibility",
};
const groupLabels: Record<string, WebsiteMessageKey> = {
	Product: "navigation:product",
	Legal: "navigation:legal",
	Trust: "navigation:trust",
	Community: "navigation:community",
};
const getData = (t: WebsiteMessage) => ({
	Product: [
		{ label: t("navigation:download"), href: DOWNLOAD_URL },
		{ label: t("navigation:developers"), href: "/developers" },
		{ label: t("navigation:pricing"), href: "/pricing" },
		{ label: t("navigation:change_log"), href: "/changelog" },
		{ label: t("navigation:blog"), href: "/blog" },
	],
	Legal: legalPageLinks("Legal").map((link) => ({
		...link,
		label: t(legalLabels[link.href]),
	})),
	Trust: legalPageLinks("Trust").map((link) => ({
		...link,
		label: t(legalLabels[link.href]),
	})),
	Community: [
		{ label: "GitHub", href: GITHUB_URL },
		{ label: "Discord", href: DISCORD_URL },
		{ label: t("navigation:releases"), href: RELEASES_URL },
		{ label: "X", href: X_URL },
	],
});

export const Footer = () => {
	const { message: t } = useWebsiteMessages();

	return (
		<footer className="bg-background relative overflow-hidden">
			<Container className="flex flex-col pt-20">
				<div className="relative z-10 flex flex-col items-center justify-center gap-18">
					<div className="grid w-full grid-cols-1 gap-15 lg:grid-cols-2 lg:gap-0">
						<div className="flex flex-col gap-4">
							<Logo className="size-8" />
							<span className="text-muted-foreground text-sm leading-5">
								{t("navigation:tagline")}
							</span>
							<div>
								<Button />
							</div>
						</div>
						<div className="grid grid-cols-2 gap-x-10 gap-y-12 md:gap-x-8">
							{Object.entries(getData(t)).map(([key, value]) => (
								<div key={key} className="flex flex-col gap-4">
									<h3 className="text-primary text-lg leading-6">
										{t(groupLabels[key])}
									</h3>
									<ul className="flex flex-col gap-4">
										{value.map((item) => (
											<li key={item.label}>
												<Link
													href={item.href}
													className="text-heading -tracking-sm text-sm leading-5 font-medium hover:underline"
												>
													{item.label}
												</Link>
											</li>
										))}
									</ul>
								</div>
							))}
						</div>
					</div>
					<div className="flex w-full flex-col justify-between gap-6 md:flex-row md:items-center md:gap-0">
						<div>
							<span className="flex items-center gap-1">
								<CopyRightIcon />
								<span className="text-muted-foreground text-xs leading-5 font-medium">
									{t("navigation:2026_zuse_all_rights_reserved")}
								</span>
							</span>
						</div>
						<div className="flex items-center gap-5">
							<Link
								href={GITHUB_URL}
								target="_blank"
								rel="noopener noreferrer"
								aria-label="GitHub"
							>
								<IconBrandGithub className="text-muted-foreground hover:text-heading size-4 transition-colors" />
							</Link>
							<Link
								href={X_URL}
								target="_blank"
								rel="noopener noreferrer"
								aria-label="X"
							>
								<XformerlyTwitter className="text-muted-foreground hover:text-heading size-4 transition-colors" />
							</Link>
							<Link
								href={INSTAGRAM_URL}
								target="_blank"
								rel="noopener noreferrer"
								aria-label="Instagram"
							>
								<IconBrandInstagram className="text-muted-foreground hover:text-heading size-4 transition-colors" />
							</Link>
							<Link
								href={DISCORD_URL}
								target="_blank"
								rel="noopener noreferrer"
								aria-label="Discord"
							>
								<IconBrandDiscord className="text-muted-foreground hover:text-heading size-4 transition-colors" />
							</Link>
						</div>
					</div>
				</div>
				<div
					aria-hidden="true"
					className="-tracking-xl text-heading pointer-events-none mt-20 -mb-[0.09em] w-full select-none overflow-hidden text-center text-[clamp(9rem,40vw,29rem)] leading-[0.72] font-medium whitespace-nowrap"
				>
					Zuse
				</div>
			</Container>
		</footer>
	);
};
