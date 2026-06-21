import { createMDX } from "fumadocs-mdx/next";

/** @type {import('next').NextConfig} */
const nextConfig = {
  pageExtensions: ["js", "jsx", "md", "mdx", "ts", "tsx"],
  images: {
    domains: ["images.unsplash.com"],
  },
};

const withMDX = createMDX();

export default withMDX(nextConfig);
