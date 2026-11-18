import { renderDocsOgImage } from "@/lib/og-image";

/** The 1200×630 share card for every docs page, prerendered at build. */
export const dynamic = "force-static";

export function GET() {
	return renderDocsOgImage();
}
