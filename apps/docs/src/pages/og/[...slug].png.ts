import { getCollection } from "astro:content";
import type { APIRoute, GetStaticPaths } from "astro";
import { createElement } from "react";
import { render } from "takumi-js";

export const getStaticPaths = (async () => {
	const docs = await getCollection("docs");
	return [
		{
			params: { slug: "index" },
			props: {
				title: "Build locally. Stay in control everywhere.",
				description:
					"The complete guide to Zuse desktop, mobile, remote access, and Serve.",
				section: "Documentation",
			},
		},
		...docs.map((entry) => ({
			params: {
				slug: entry.id.replace(/\.(md|mdx)$/u, "").replace(/\/index$/u, ""),
			},
			props: {
				title: entry.data.title,
				description: entry.data.description,
				section: entry.data.section,
			},
		})),
	];
}) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ props }) => {
	const { title, description, section } = props as {
		readonly title: string;
		readonly description: string;
		readonly section: string;
	};
	const card = createElement(
		"div",
		{
			style: {
				width: "1200px",
				height: "630px",
				display: "flex",
				flexDirection: "column",
				justifyContent: "space-between",
				backgroundColor: "#0a0d0a",
				color: "#f2f4ef",
				padding: "72px",
				fontFamily: "Inter, sans-serif",
			},
		},
		createElement(
			"div",
			{
				style: {
					display: "flex",
					alignItems: "center",
					gap: "18px",
					fontSize: "26px",
				},
			},
			createElement(
				"div",
				{
					style: {
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						width: "46px",
						height: "46px",
						borderRadius: "11px",
						backgroundColor: "#c7f65a",
						color: "#17210d",
						fontWeight: 800,
					},
				},
				"Z",
			),
			createElement("span", { style: { fontWeight: 650 } }, "Zuse"),
			createElement("span", { style: { color: "#6f776d" } }, "/"),
			createElement("span", { style: { color: "#a5ada2" } }, "Docs"),
		),
		createElement(
			"div",
			{ style: { display: "flex", flexDirection: "column", gap: "20px" } },
			createElement(
				"div",
				{
					style: {
						color: "#b8eb4a",
						fontSize: "19px",
						letterSpacing: "0.14em",
						textTransform: "uppercase",
					},
				},
				section,
			),
			createElement(
				"div",
				{
					style: {
						maxWidth: "980px",
						fontSize: "66px",
						lineHeight: 1.02,
						letterSpacing: "-0.045em",
						fontWeight: 650,
					},
				},
				title,
			),
			createElement(
				"div",
				{
					style: {
						maxWidth: "880px",
						color: "#aeb5ab",
						fontSize: "25px",
						lineHeight: 1.42,
					},
				},
				description,
			),
		),
		createElement(
			"div",
			{
				style: {
					display: "flex",
					justifyContent: "space-between",
					color: "#747c72",
					fontSize: "18px",
				},
			},
			createElement("span", null, "docs.zuse.sh"),
			createElement("span", null, "Desktop · Mobile · Remote · Serve"),
		),
	);
	const image = await render(card, { width: 1200, height: 630 });
	return new Response(image as BodyInit, {
		headers: {
			"content-type": "image/png",
			"cache-control": "public, max-age=31536000, immutable",
		},
	});
};
