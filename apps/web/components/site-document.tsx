import type { WebsiteLocale } from "@zuse/i18n/registry";
import { WebsiteProvider } from "@zuse/i18n/website/react";
import { loadWebsiteCatalog } from "@zuse/i18n/website/server";
import type { Metadata } from "next";
import {
	DM_Mono,
	Geist,
	Geist_Mono,
	Inter,
	Schibsted_Grotesk,
} from "next/font/google";
import { Navbar } from "@/components/navbar";
import { ProgressiveBlur } from "@/components/progressive-blur";
import { cn } from "@/lib/utils";

import "@/app/globals.css";
import "@/components/site-typography.css";
import "@/components/editorial.css";
import { DownloadShortcut } from "@/components/download-shortcut";
import { Footer } from "@/components/footer";
import { VerticalLine } from "@/components/line";
import { ThemeProvider } from "@/components/theme-provider";
import { getGitHubStars } from "@/lib/github";
import { getSEO } from "@/lib/seo";

export const metadata: Metadata = getSEO();

const inter = Inter({
	subsets: ["latin"],
	variable: "--font-inter",
	weight: ["400", "500", "600", "700", "800"],
});

const geistMono = Geist_Mono({
	subsets: ["latin"],
	variable: "--font-geist-mono",
	weight: ["400", "500", "600", "700", "800"],
});

const DMMono = DM_Mono({
	subsets: ["latin"],
	variable: "--font-dm-mono",
	weight: ["300", "400", "500"],
});

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });

const schibstedGrotesk = Schibsted_Grotesk({
	subsets: ["latin"],
	weight: ["400", "500", "600", "700"],
	variable: "--font-schibsted-grotesk",
});

export async function SiteDocument({
	children,
	locale = "en",
	studio = false,
}: Readonly<{
	children: React.ReactNode;
	locale?: WebsiteLocale;
	studio?: boolean;
}>) {
	const [githubStars, messages] = await Promise.all([
		studio ? Promise.resolve(0) : getGitHubStars(),
		loadWebsiteCatalog(locale),
	]);

	return (
		<html lang={locale} suppressHydrationWarning>
			<body
				className={cn(
					inter.variable,
					geistMono.variable,
					DMMono.variable,
					geist.variable,
					schibstedGrotesk.variable,
					studio
						? "zuse-studio font-sans antialiased"
						: "zuse-site bg-background relative overflow-x-hidden font-sans antialiased",
				)}
			>
				<WebsiteProvider locale={locale} messages={messages}>
					<ThemeProvider>
						{studio ? (
							children
						) : (
							<>
								<DownloadShortcut />
								{/* Framed column with dotted rails on both edges — the base layout's
            signature. Everything on the site lives inside these rails. */}
								<div className="relative mx-auto w-full max-w-6xl">
									<VerticalLine />
									<VerticalLine className="right-0 left-auto" />
									<Navbar githubStars={githubStars} />
									<div className="site-content">{children}</div>
									<Footer />
								</div>
								<ProgressiveBlur
									className="site-bottom-blur pointer-events-none fixed inset-x-0 bottom-0 z-40 mx-auto h-[8%] w-full max-w-6xl"
									blurIntensity={1}
								/>
							</>
						)}
					</ThemeProvider>
				</WebsiteProvider>
			</body>
		</html>
	);
}
