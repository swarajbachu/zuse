import {
	IconBrandDiscord,
	IconBrandGithub,
	IconBrandInstagram,
} from "@tabler/icons-react";
import Link from "next/link";
import { Button } from "@/components/button";
import { Container } from "@/components/container";
import { CopyRightIcon, XformerlyTwitter } from "@/components/icons/general";
import { Logo } from "@/components/logo";
import {
	DISCORD_URL,
	DOWNLOAD_URL,
	GITHUB_URL,
	INSTAGRAM_URL,
	RELEASES_URL,
	TAGLINE,
	X_URL,
} from "@/lib/site";

// Every link here must resolve. No placeholder hrefs — pages get linked when
// they exist.
const data = {
	Product: [
		{ label: "Download", href: DOWNLOAD_URL },
		{ label: "Change Log", href: "/changelog" },
		{ label: "Blog", href: "/blog" },
		{ label: "Privacy Policy", href: "/privacy" },
	],
	Community: [
		{ label: "GitHub", href: GITHUB_URL },
		{ label: "Discord", href: DISCORD_URL },
		{ label: "Releases", href: RELEASES_URL },
		{ label: "X", href: X_URL },
	],
};

export const Footer = () => {
	return (
		<footer className="bg-background relative overflow-hidden">
			<Container className="flex flex-col pt-20">
				<div className="relative z-10 flex flex-col items-center justify-center gap-18">
					<div className="grid w-full grid-cols-1 gap-15 lg:grid-cols-2 lg:gap-0">
						<div className="flex flex-col gap-4">
							<Logo className="size-8" />
							<span className="text-muted-foreground text-sm leading-5">
								{TAGLINE}
							</span>
							<div>
								<Button />
							</div>
						</div>
						<div className="grid grid-cols-2 gap-10 md:gap-0">
							{Object.entries(data).map(([key, value]) => (
								<div key={key} className="flex flex-col gap-4">
									<h3 className="text-muted-foreground -tracking-sm text-xs leading-5 font-medium">
										{key}
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
									2026 Zuse — All Rights Reserved
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
