import type { Metadata } from "next";
import { SITE_URL } from "@/lib/layout.shared";

export const DOCS_SITE_NAME = "Zuse Docs";
export const DOCS_DESCRIPTION =
	"Guides and reference for Zuse desktop, mobile, remote access, and Serve.";
export const DOCS_TWITTER = "@zuse_sh";
/** The marketing site's canonical origin, used for publisher links in structured data. */
export const PRODUCT_CANONICAL_URL = "https://www.zuse.sh";

/** Served by `app/og.png/route.tsx`; 1200×630 PNG. */
export const DOCS_OG_IMAGE = {
	url: "/og.png",
	width: 1200,
	height: 630,
	alt: DOCS_SITE_NAME,
} as const;

/**
 * Open Graph and Twitter metadata for a docs page. A page's `openGraph`
 * replaces the layout's rather than merging with it, so every page builds the
 * full object from here.
 */
export function docsSocialMetadata({
	title,
	description,
	path,
	type = "article",
}: {
	title: string;
	description?: string | undefined;
	path: string;
	type?: "article" | "website";
}): Pick<Metadata, "openGraph" | "twitter"> {
	const fullTitle = `${title} | ${DOCS_SITE_NAME}`;
	return {
		openGraph: {
			type,
			siteName: DOCS_SITE_NAME,
			title: fullTitle,
			description,
			url: new URL(path, SITE_URL).toString(),
			locale: "en_US",
			images: [DOCS_OG_IMAGE],
		},
		twitter: {
			card: "summary_large_image",
			title: fullTitle,
			description,
			images: [DOCS_OG_IMAGE.url],
			creator: DOCS_TWITTER,
		},
	};
}
