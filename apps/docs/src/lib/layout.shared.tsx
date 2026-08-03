import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { ArrowUpRight, Download } from "lucide-react";
import Image from "next/image";

export const SITE_URL = "https://docs.zuse.sh";
export const GITHUB_URL = "https://github.com/swarajbachu/zuse";

export function baseOptions(): BaseLayoutProps {
	return {
		nav: {
			url: "/start",
			title: (
				<span className="flex items-center gap-2.5 font-medium">
					<Image
						src="/app-icon.png"
						width="28"
						height="28"
						alt=""
						className="size-7 rounded-[7px]"
					/>
					<span>Zuse</span>
					<span className="text-fd-muted-foreground font-normal">Docs</span>
				</span>
			),
			transparentMode: "none",
		},
		links: [
			{
				type: "main",
				text: "Product",
				url: "https://zuse.sh",
				external: true,
				icon: <ArrowUpRight />,
			},
			{
				type: "button",
				text: "Download",
				url: "https://zuse.sh/download",
				external: true,
				icon: <Download />,
			},
			{
				type: "icon",
				label: "GitHub",
				text: "GitHub",
				url: GITHUB_URL,
				external: true,
				icon: <GitHubIcon />,
			},
		],
	};
}

function GitHubIcon() {
	return (
		<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
			<path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.74-1.55-2.57-.3-5.27-1.29-5.27-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.47.11-3.05 0 0 .96-.31 3.16 1.18a10.95 10.95 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.62 1.58.23 2.76.11 3.05.74.81 1.18 1.83 1.18 3.09 0 4.41-2.7 5.39-5.28 5.68.42.36.79 1.06.79 2.13v3.16c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
		</svg>
	);
}
