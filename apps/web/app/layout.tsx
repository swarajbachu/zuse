import type { Metadata } from "next";
import { Geist_Mono, Inter, DM_Mono } from "next/font/google";
import { Navbar } from "@/components/navbar";
import { cn } from "@/lib/utils";

import "./globals.css";
import { Footer } from "@/components/footer";
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={cn(
          inter.variable,
          geistMono.variable,
          DMMono.variable,
          `bg-background relative font-sans antialiased`,
        )}
      >
        <Navbar />
        {children}
        <Footer />
      </body>
    </html>
  );
}
