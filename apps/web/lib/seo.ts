import type { Metadata } from "next";

const APEX_HOST = "zuse.sh";
const CANONICAL_ORIGIN = "https://www.zuse.sh";

/**
 * The marketing site is served at www.zuse.sh; the apex host 308s there.
 * Normalize a misconfigured apex env so canonicals, sitemap, and robots
 * stay on the host that actually serves the page. Leave other hosts alone
 * so preview deployments can still set NEXT_PUBLIC_SITE_URL.
 */
export function resolveSiteUrl(
	raw = process.env.NEXT_PUBLIC_SITE_URL ?? CANONICAL_ORIGIN,
): string {
	try {
		const url = new URL(raw);
		if (url.hostname === APEX_HOST) {
			url.hostname = `www.${APEX_HOST}`;
		}
		url.protocol = "https:";
		url.pathname = "/";
		url.search = "";
		url.hash = "";
		return url.origin;
	} catch {
		return CANONICAL_ORIGIN;
	}
}

export const siteConfig = {
	name: "Zuse",
	description:
		"Run open source cloud agents with Zuse. Work locally or in isolated cloud workspaces, use your existing model subscriptions, and review every change.",

	url: resolveSiteUrl(),
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
