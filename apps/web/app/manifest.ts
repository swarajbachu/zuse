import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
	return {
		name: "Zuse",
		short_name: "Zuse",
		description:
			"Open-source autonomous coding workspace for local and cloud agents.",
		start_url: "/",
		display: "standalone",
		background_color: "#111113",
		theme_color: "#c8ff3d",
		icons: [{ src: "/app-icon.png", sizes: "1024x1024", type: "image/png" }],
	};
}
