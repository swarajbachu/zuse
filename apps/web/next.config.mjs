import { createMDX } from "fumadocs-mdx/next";

/** @type {import('next').NextConfig} */
const nextConfig = {
	pageExtensions: ["js", "jsx", "md", "mdx", "ts", "tsx"],
	images: {
		domains: ["images.unsplash.com"],
	},
	async redirects() {
		return [
			{
				source: "/docs/repository-settings",
				destination: "https://docs.zuse.sh/projects/repository-settings",
				permanent: true,
			},
			{
				source: "/docs/schemas",
				destination: "https://docs.zuse.sh/reference/schemas",
				permanent: true,
			},
			{
				source: "/docs/scripts",
				destination: "https://docs.zuse.sh/projects/scripts",
				permanent: true,
			},
			{
				source: "/docs/settings",
				destination: "https://docs.zuse.sh/reference/settings",
				permanent: true,
			},
			{
				source: "/docs/worktree-includes",
				destination: "https://docs.zuse.sh/projects/file-includes",
				permanent: true,
			},
			{
				source: "/docs/zuse-skill",
				destination: "https://docs.zuse.sh/reference/bundled-skill",
				permanent: true,
			},
			{
				source: "/docs/:path*",
				destination: "https://docs.zuse.sh/:path*",
				permanent: true,
			},
		];
	},
};

const withMDX = createMDX();

export default withMDX(nextConfig);
