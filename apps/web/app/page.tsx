import { FAQ } from "@/components/faq";
import { Hero } from "@/components/landing/hero";
import { HorizontalLine } from "@/components/landing/line";
import { ProductShowcase } from "@/components/landing/product-showcase";
import { HomepageStructuredData } from "@/components/seo/homepage-structured-data";
import { getSEO } from "@/lib/seo";

export const metadata = getSEO({
	absoluteTitle: "Zuse — Open-source autonomous coding workspace",
	description:
		"Run autonomous coding agents locally or in live cloud workspaces with Zuse. Plan, code, test, review diffs, and prepare pull requests using your existing AI subscriptions.",
	path: "/",
	keywords: [
		"open source coding agent",
		"autonomous coding workspace",
		"AI coding agents",
		"cloud coding agents",
		"Claude Code GUI",
		"Codex desktop app",
		"coding agent orchestration",
		"Git worktree management",
	],
});

export default function Home() {
	return (
		<main>
			<HomepageStructuredData />
			<Hero />
			<ProductShowcase />
			<HorizontalLine />
			<FAQ />
		</main>
	);
}
