import {
	blogOgStaticParams,
	renderBlogOgImageForSlug,
} from "@/lib/blog-og-image";

/**
 * Per-post 1200×630 share card at /blog/<slug>/og.png, prerendered at build.
 * A plain route (not the opengraph-image file convention) keeps the URL
 * stable so metadata and JSON-LD can point at it.
 */
export const dynamic = "force-static";
export const dynamicParams = false;
export const generateStaticParams = blogOgStaticParams;

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	return renderBlogOgImageForSlug(params);
}
