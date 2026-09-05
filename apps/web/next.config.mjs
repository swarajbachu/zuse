import { createMDX } from "fumadocs-mdx/next";

/** @type {import('next').NextConfig} */
const nextConfig = {
	pageExtensions: ["js", "jsx", "md", "mdx", "ts", "tsx"],
	async headers() {
		return [
			{
				// Published model catalog: installed apps poll this with ETags.
				// Short browser TTL, one hour at the CDN, and a day of
				// stale-while-revalidate so a deploy propagates without a stampede.
				source: "/models/:path*",
				headers: [
					{
						key: "Cache-Control",
						value:
							"public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
					},
					{ key: "Access-Control-Allow-Origin", value: "*" },
				],
			},
			{
				source: "/schemas/:path*",
				headers: [
					{
						key: "Cache-Control",
						value: "public, max-age=3600, s-maxage=86400",
					},
					{ key: "Access-Control-Allow-Origin", value: "*" },
				],
			},
		];
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
