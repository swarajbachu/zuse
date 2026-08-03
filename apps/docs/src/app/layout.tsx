import "@fontsource-variable/inter";
import "@fontsource-variable/geist-mono";
import "./globals.css";

import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { SITE_URL } from "@/lib/layout.shared";

export const metadata: Metadata = {
	metadataBase: new URL(SITE_URL),
	title: {
		default: "Zuse Documentation",
		template: "%s — Zuse Docs",
	},
	description:
		"Guides and reference for Zuse desktop, mobile, remote access, and Serve.",
	icons: {
		icon: "/app-icon.png",
		apple: "/app-icon.png",
	},
};

export const viewport: Viewport = {
	colorScheme: "light dark",
	themeColor: [
		{ media: "(prefers-color-scheme: light)", color: "#fafafa" },
		{ media: "(prefers-color-scheme: dark)", color: "#0f0f0f" },
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
