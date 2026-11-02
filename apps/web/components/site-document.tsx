import type { WebsiteLocale } from "@zuse/i18n/registry";
import { WebsiteProvider } from "@zuse/i18n/website/react";
import { loadWebsiteCatalog } from "@zuse/i18n/website/server";
import type { Metadata } from "next";
import { Navbar } from "@/components/navbar";
import { ProgressiveBlur } from "@/components/progressive-blur";
import { cn } from "@/lib/utils";

import "@fontsource-variable/inter";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/schibsted-grotesk";
import "@fontsource/dm-mono/latin-300.css";
import "@fontsource/dm-mono/latin-400.css";
import "@fontsource/dm-mono/latin-500.css";
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
