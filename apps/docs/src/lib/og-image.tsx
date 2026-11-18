import { ImageResponse } from "next/og";
import { DOCS_DESCRIPTION } from "@/lib/seo";

export const OG_SIZE = { width: 1200, height: 630 } as const;

const ACCENT = "#d6f545";

/** 1200×630 PNG share card shared by every docs page. */
export function renderDocsOgImage() {
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
			<div style={{ display: "flex", alignItems: "center", fontSize: 30 }}>
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
			<div style={{ display: "flex", flexDirection: "column" }}>
				<div
					style={{
						display: "flex",
						fontSize: 112,
						lineHeight: 1,
						fontWeight: 700,
						letterSpacing: -4,
					}}
				>
					Documentation
				</div>
				<div
					style={{
						display: "flex",
						marginTop: 28,
						maxWidth: 900,
						fontSize: 36,
						lineHeight: 1.3,
						color: "#a3a3a3",
					}}
				>
					{DOCS_DESCRIPTION}
				</div>
			</div>
			<div style={{ display: "flex", fontSize: 26, color: ACCENT }}>
				docs.zuse.sh
			</div>
		</div>,
		OG_SIZE,
	);
}
