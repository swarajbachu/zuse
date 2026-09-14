"use client";
import {
	IconBrandDiscordFilled,
	IconMenu2,
	IconMoonFilled,
	IconSunFilled,
	IconX,
} from "@tabler/icons-react";
import { websitePath } from "@zuse/i18n/registry";
import {
	useWebsiteMessages,
	type WebsiteMessage,
} from "@zuse/i18n/website/react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { useState } from "react";
import { Logo } from "@/components/logo";
import {
	getDownloadHref,
	getDownloadLabel,
	PlatformDownloadIcon,
	useDownloadPlatform,
} from "@/components/platform-download";
import { DISCORD_URL, GITHUB_URL } from "@/lib/site";
import { cn } from "@/lib/utils";
import { LanguageSelector } from "./language-selector";

const getNavItems = (t: WebsiteMessage) => [
	{ label: t("navigation:how_it_works"), href: "/#workflow" },
	{ label: t("navigation:docs"), href: "/docs" },
	{ label: t("navigation:cloud"), href: "/#cloud-interest" },
	{ label: t("navigation:changelog"), href: "/changelog" },
];

export const Navbar = ({
	className,
	githubStars,
}: {
	className?: string | undefined;
	githubStars?: number | null;
}) => {
	const { message: t, locale } = useWebsiteMessages();

	const [isMenuOpen, setIsMenuOpen] = useState(false);

	return (
		<nav
			className={cn(
				"bg-background/85 border-border sticky top-0 z-50 w-full border-b backdrop-blur-xl supports-[backdrop-filter]:bg-background/70",
				className,
			)}
		>
			<div className="max-w-container mx-auto px-4 sm:px-8">
				<div className="flex h-16 items-center justify-between">
					<div className="flex shrink-0 items-center gap-2 xl:min-w-45">
						<Logo className="size-8" />
					</div>
					<div className="hidden xl:block">
						<div className="flex items-center gap-3 xl:gap-5">
							{getNavItems(t).map((item) => (
								<Link
									key={item.label}
									href={
										item.href.startsWith("/#")
											? websitePath(locale) + item.href.slice(1)
											: item.href
									}
									className="text-muted-foreground hover:text-heading focus-visible:ring-heading/60 inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none"
								>
									{item.label}
								</Link>
							))}
						</div>
					</div>

					<div className="hidden items-center gap-2 xl:flex">
						<DiscordLink />
						<ThemeToggle />
						<LanguageSelector />
						<GitHubStarLink stars={githubStars} />
						<DownloadLink />
					</div>

					<div className="flex items-center gap-2 xl:hidden">
						<DiscordLink />
						<ThemeToggle />
						<LanguageSelector />
						<button
							type="button"
							aria-label={
								isMenuOpen
									? t("navigation:close_menu")
									: t("navigation:open_menu")
							}
							aria-expanded={isMenuOpen}
							onClick={() => setIsMenuOpen(!isMenuOpen)}
							className="text-muted-foreground hover:text-heading focus-visible:ring-heading/60 relative flex size-7 items-center justify-center rounded-md transition-colors duration-200 after:absolute after:-inset-2 focus-visible:ring-2 focus-visible:outline-none"
						>
							{isMenuOpen ? (
								<IconX className="size-4" />
							) : (
								<IconMenu2 className="size-4" />
							)}
						</button>
					</div>
				</div>

				{isMenuOpen ? (
					<div className="border-border border-t pb-4 xl:hidden">
						<div className="flex flex-col gap-1 pt-2">
							{getNavItems(t).map((item) => (
								<Link
									key={item.label}
									href={
										item.href.startsWith("/#")
											? websitePath(locale) + item.href.slice(1)
											: item.href
									}
									className="text-muted-foreground hover:text-heading focus-visible:ring-heading/60 flex min-h-11 items-center rounded-lg px-3 text-base font-medium transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none"
									onClick={() => setIsMenuOpen(false)}
								>
									{item.label}
								</Link>
							))}
							<div className="border-border mt-3 flex flex-col gap-2 border-t pt-4">
								<GitHubStarLink
									stars={githubStars}
									onClick={() => setIsMenuOpen(false)}
								/>
								<DownloadLink className="w-full" />
							</div>
						</div>
					</div>
				) : null}
			</div>
		</nav>
	);
};

const GitHubStarLink = ({
	stars,
	onClick,
}: {
	stars?: number | null;
	onClick?: () => void;
}) => {
	const { message: t, locale } = useWebsiteMessages();
	return (
		<a
			href={GITHUB_URL}
			target="_blank"
			rel="noopener noreferrer"
			onClick={onClick}
			aria-label={
				stars === null || stars === undefined
					? t("navigation:star_zuse_on_github")
					: t("navigation:star_zuse_on_github_stars", {
							value0: stars.toLocaleString(locale),
						})
			}
			className="group border-border bg-card text-heading hover:bg-elevated focus-visible:ring-heading/60 relative flex h-7 shrink-0 items-center rounded-md border text-xs transition-colors duration-200 after:absolute after:-inset-y-2 after:inset-x-0 focus-visible:ring-2 focus-visible:outline-none"
		>
			<span className="flex items-center gap-1.5 px-2.5 font-medium">
				<GitHubIcon className="size-3.5" />
				{t("navigation:star")}
			</span>
			{stars !== null && stars !== undefined ? (
				<span className="border-border text-muted-foreground flex min-w-8 self-stretch items-center justify-center border-l px-2 font-mono text-[11px] tabular-nums">
					{stars.toLocaleString(locale)}
				</span>
			) : null}
		</a>
	);
};

const DownloadLink = ({ className }: { className?: string }) => {
	const { message: t } = useWebsiteMessages();

	const platform = useDownloadPlatform();

	return (
		<Link
			href={getDownloadHref(platform)}
			aria-label={getDownloadLabel(platform, t)}
			aria-keyshortcuts="D"
			className={cn(
				"bg-primary focus-visible:ring-heading/60 relative flex h-7 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-black transition-opacity duration-200 after:absolute after:-inset-y-2 after:inset-x-0 hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none",
				className,
			)}
		>
			<PlatformDownloadIcon platform={platform} className="size-3.5" />
			{t("navigation:download")}
			<kbd className="rounded border border-black/15 bg-black/10 px-1 py-px font-sans text-[9px] leading-none text-black/65">
				D
			</kbd>
		</Link>
	);
};

const DiscordLink = () => {
	const { message: t } = useWebsiteMessages();
	return (
		<a
			href={DISCORD_URL}
			target="_blank"
			rel="noopener noreferrer"
			aria-label={t("navigation:join_the_zuse_discord")}
			className="border-border bg-card text-muted-foreground hover:bg-elevated hover:text-heading focus-visible:ring-heading/60 relative flex size-7 items-center justify-center rounded-md border transition-colors duration-200 after:absolute after:-inset-2 focus-visible:ring-2 focus-visible:outline-none"
		>
			<IconBrandDiscordFilled aria-hidden="true" className="size-3.5" />
		</a>
	);
};

const ThemeToggle = () => {
	const { message: t } = useWebsiteMessages();

	const { resolvedTheme, setTheme } = useTheme();
	const isDark = resolvedTheme !== "light";

	return (
		<button
			type="button"
			aria-label={t(
				isDark ? "navigation:light_theme" : "navigation:dark_theme",
			)}
			onClick={() => setTheme(isDark ? "light" : "dark")}
			className="border-border bg-card text-muted-foreground hover:bg-elevated hover:text-heading focus-visible:ring-heading/60 relative flex size-7 items-center justify-center rounded-md border transition-colors duration-200 after:absolute after:-inset-2 focus-visible:ring-2 focus-visible:outline-none"
		>
			{isDark ? (
				<IconSunFilled aria-hidden="true" className="size-3.5" />
			) : (
				<IconMoonFilled aria-hidden="true" className="size-3.5" />
			)}
		</button>
	);
};

const GitHubIcon = ({ className }: { className?: string }) => (
	<svg
		aria-hidden="true"
		viewBox="0 0 24 24"
		fill="currentColor"
		className={className}
	>
		<path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.74-1.55-2.57-.3-5.27-1.29-5.27-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.47.11-3.05 0 0 .96-.31 3.16 1.18a10.95 10.95 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.62 1.58.23 2.76.11 3.05.74.81 1.18 1.83 1.18 3.09 0 4.41-2.7 5.39-5.28 5.68.42.36.79 1.06.79 2.13v3.16c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
	</svg>
);
