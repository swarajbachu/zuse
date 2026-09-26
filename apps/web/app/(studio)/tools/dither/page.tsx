import "./studio.css";
import type { Metadata } from "next";
import { DitherEditor } from "@/components/dither/dither-editor";

export const metadata: Metadata = {
	title: "Dither studio — Zuse",
	description:
		"Create a dithered wallpaper with local image processing, color palettes, and PNG export. Free, private, and entirely in your browser.",
	alternates: { canonical: "/tools/dither" },
};

export default function DitherPage() {
	return <DitherEditor />;
}
