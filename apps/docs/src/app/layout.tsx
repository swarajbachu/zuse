import "@fontsource-variable/inter";
import "@fontsource-variable/geist-mono";
import "./globals.css";

import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { SITE_URL } from "@/lib/layout.shared";
import {
	DOCS_DESCRIPTION,
	DOCS_SITE_NAME,
	docsSocialMetadata,
} from "@/lib/seo";

export const metadata: Metadata = {
	metadataBase: new URL(SITE_URL),
	title: {
		default: "Zuse Documentation",
		template: `%s | ${DOCS_SITE_NAME}`,
	},
	description: DOCS_DESCRIPTION,
	...docsSocialMetadata({
		title: "Zuse Documentation",
		description: DOCS_DESCRIPTION,
		path: "/start",
		type: "website",
	}),
	icons: {
		icon: "/app-icon.png",
		apple: "/app-icon.png",
	},
};

export const viewport: Viewport = {
	colorScheme: "light dark",
	themeColor: [
		{ media: "(prefers-color-scheme: light)", color: "#ececec" },
		{ media: "(prefers-color-scheme: dark)", color: "#0d0d0d" },
	],
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en" suppressHydrationWarning>
			<body>
				<RootProvider
					theme={{
						attribute: "class",
						defaultTheme: "system",
						enableSystem: true,
					}}
				>
					{children}
				</RootProvider>
			</body>
		</html>
	);
}
