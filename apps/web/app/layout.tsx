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

import "./globals.css";
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

export default async function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	const githubStars = await getGitHubStars();

	return (
		<html lang="en" suppressHydrationWarning>
			<body
				className={cn(
					inter.variable,
					geistMono.variable,
					DMMono.variable,
					geist.variable,
					schibstedGrotesk.variable,
					`bg-background relative overflow-x-hidden font-sans antialiased`,
				)}
			>
				<ThemeProvider>
					<DownloadShortcut />
					{/* Framed column with dotted rails on both edges — the base layout's
            signature. Everything on the site lives inside these rails. */}
					<div className="relative mx-auto w-full max-w-6xl">
						<VerticalLine />
						<VerticalLine className="right-0 left-auto" />
						<Navbar githubStars={githubStars} />
						{children}
						<Footer />
					</div>
					<ProgressiveBlur
						className="pointer-events-none fixed inset-x-0 bottom-0 z-40 mx-auto h-[8%] w-full max-w-6xl"
						blurIntensity={1}
					/>
				</ThemeProvider>
			</body>
		</html>
	);
}
