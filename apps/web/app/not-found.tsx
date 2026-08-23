import Link from "next/link";
import { Container } from "@/components/container";
import { getSEO } from "@/lib/seo";

export const metadata = getSEO({
	absoluteTitle: "Page not found | Zuse",
	description: "Find the Zuse page or developer resource you were looking for.",
	path: "/404",
	noIndex: true,
});

const recoveryLinks = [
	{ href: "/", label: "Homepage" },
	{ href: "/developers", label: "Developer resources" },
	{ href: "/llms.txt", label: "Agent instructions" },
	{ href: "/sitemap.xml", label: "Site map" },
	{ href: "https://docs.zuse.sh", label: "Documentation" },
];

export default function NotFound() {
	return (
		<main>
			<Container className="flex min-h-[65vh] flex-col justify-center py-32">
				<p className="text-primary font-mono text-sm font-medium">404</p>
				<h1 className="text-heading mt-3 font-display text-4xl font-semibold tracking-tight md:text-6xl">
					Page not found
				</h1>
				<p className="text-muted-foreground mt-5 max-w-xl text-base leading-7">
					That Zuse path does not exist. Continue with one of these verified
					resources.
				</p>
				<nav
					aria-label="404 recovery links"
					className="mt-8 flex flex-wrap gap-3"
				>
					{recoveryLinks.map((link) => (
						<Link
							key={link.href}
							href={link.href}
							className="border-border text-heading hover:border-primary/50 hover:bg-muted rounded-lg border px-3 py-2 text-sm font-medium transition-colors"
						>
							{link.label}
						</Link>
					))}
				</nav>
			</Container>
		</main>
	);
}
