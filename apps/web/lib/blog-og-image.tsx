import { notFound } from "next/navigation";
import { ImageResponse } from "next/og";
import { blog } from "@/lib/source";

export const BLOG_OG_SIZE = { width: 1200, height: 630 } as const;

/** Path of the generated share card for a post URL such as /blog/slug. */
export const blogOgImagePath = (postUrl: string) => `${postUrl}/og.png`;

const ACCENT = "#d6f545";

/** Title size steps down with length so long titles never overflow the card. */
export function blogOgTitleSize(title: string): number {
	if (title.length <= 40) return 80;
	if (title.length <= 60) return 68;
	return 58;
}

/** 1200×630 PNG share card for a Journal post, rendered at build time. */
export function renderBlogOgImage({
	title,
	category,
	slug,
}: {
	title: string;
	category: string;
	slug: string;
}) {
	return new ImageResponse(
		<div
			style={{
				width: "100%",
				height: "100%",
				display: "flex",
				flexDirection: "column",
				justifyContent: "space-between",
				padding: "64px 72px",
				background: "#0a0a0a",
				backgroundImage: `radial-gradient(circle at 92% 108%, ${ACCENT}33 0%, #0a0a0a00 55%)`,
				color: "#ffffff",
				fontFamily: "sans-serif",
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					fontSize: 30,
				}}
			>
				<div style={{ display: "flex", alignItems: "center" }}>
					<div
						style={{
							width: 28,
							height: 28,
							marginRight: 16,
							background: ACCENT,
							borderRadius: 6,
						}}
					/>
					<span style={{ fontWeight: 700 }}>Zuse</span>
				</div>
				<span
					style={{
						fontSize: 24,
						letterSpacing: 4,
						color: ACCENT,
						textTransform: "uppercase",
					}}
				>
					{`Journal · ${category}`}
				</span>
			</div>
			<div
				style={{
					display: "flex",
					fontSize: blogOgTitleSize(title),
					lineHeight: 1.08,
					fontWeight: 700,
					letterSpacing: -2,
					maxWidth: 1040,
				}}
			>
				{title}
			</div>
			<div
				style={{
					display: "flex",
					fontSize: 26,
					color: "#a3a3a3",
				}}
			>
				{`zuse.sh/blog/${slug}`}
			</div>
		</div>,
		BLOG_OG_SIZE,
	);
}

/** Shared by the opengraph-image and twitter-image routes of a post. */
export async function renderBlogOgImageForSlug(
	params: Promise<{ id: string }>,
) {
	const { id } = await params;
	const page = blog.getPage([id]);
	if (!page) notFound();
	return renderBlogOgImage({
		title: page.data.title,
		category: page.data.category,
		slug: id,
	});
}

export function blogOgStaticParams(): { id: string }[] {
	return blog.getPages().map((page) => ({ id: page.slugs[0] }));
}
