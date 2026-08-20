import type { Metadata } from "next";

export const siteConfig = {
	name: "Zuse",
	description:
		"Zuse is an open-source autonomous coding workspace for local and cloud agents. Plan, code, test, review diffs, and prepare pull requests with Claude Code, Codex, Cursor, Gemini, Grok, OpenCode, and Kiro.",
	// Override in production via NEXT_PUBLIC_SITE_URL.
	url: process.env.NEXT_PUBLIC_SITE_URL ?? "https://zuse.sh",
	ogImage: "/og.png",
	icon: "/app-icon.png",
	twitter: "@zuse_sh",
};

export interface GetSEOOptions {
	/** Page specific title. Rendered as `${title} | ${siteName}`. Omit for the site default. */
	title?: string;
	/** Full title used verbatim, without the `| ${siteName}` suffix. Wins over `title`. */
	absoluteTitle?: string;
	description?: string;
	/** Path of the page, e.g. "/blog". Used for the canonical URL and og:url. */
	path?: string;
	/** Absolute or root relative OG / Twitter image. */
	image?: string;
	keywords?: string[];
	/** Set to true to keep the page out of search engines. */
	noIndex?: boolean;
}

/**
 * Builds a complete Next.js `Metadata` object (title, description, canonical,
 * Open Graph, Twitter, robots, etc.) from a few page level inputs so every page
 * exposes consistent, SEO ready metadata.
 */
export function getSEO({
	title,
	absoluteTitle,
	description = siteConfig.description,
	path = "/",
	image = siteConfig.ogImage,
	keywords,
	noIndex = false,
}: GetSEOOptions = {}): Metadata {
	const resolvedTitle =
		absoluteTitle ??
		(title ? `${title} | ${siteConfig.name}` : siteConfig.name);
	const url = new URL(path, siteConfig.url).toString();

	return {
		metadataBase: new URL(siteConfig.url),
		title: resolvedTitle,
		description,
		applicationName: siteConfig.name,
		category: "Developer Tools",
		manifest: "/manifest.webmanifest",
		icons: {
			icon: siteConfig.icon,
			shortcut: siteConfig.icon,
			apple: siteConfig.icon,
		},
		keywords,
		authors: [{ name: siteConfig.name, url: siteConfig.url }],
		creator: siteConfig.name,
		publisher: siteConfig.name,
		alternates: {
			canonical: url,
			languages: { "en-US": url },
		},
		openGraph: {
			type: "website",
			siteName: siteConfig.name,
			title: resolvedTitle,
			description,
			url,
			locale: "en_US",
			images: [
				{
					url: image,
					width: 1200,
					height: 630,
					alt: resolvedTitle,
				},
			],
		},
		twitter: {
			card: "summary_large_image",
			title: resolvedTitle,
			description,
			images: [image],
			creator: siteConfig.twitter,
		},
		robots: noIndex
			? { index: false, follow: false }
			: {
					index: true,
					follow: true,
					googleBot: {
						index: true,
						follow: true,
						"max-image-preview": "large",
						"max-snippet": -1,
						"max-video-preview": -1,
					},
				},
	};
}
