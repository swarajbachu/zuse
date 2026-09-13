import Link from "next/link";
import { Container } from "@/components/container";
import { getSEO } from "@/lib/seo";

export const metadata = getSEO({
	title: "Developer Resources",
	description:
		"Zuse developer documentation, OpenAPI specification, agent instructions, API availability, and local MCP integration details.",
	path: "/developers",
	keywords: [
		"Zuse developer resources",
		"Zuse API",
		"Zuse OpenAPI",
		"Zuse MCP server",
		"Zuse documentation",
	],
});

const resources = [
	{
		title: "Documentation",
		description:
			"Set up Zuse, configure repositories, and understand local workspace behavior.",
		href: "https://docs.zuse.sh",
		label: "Read Zuse documentation",
	},
	{
		title: "OpenAPI specification",
		description:
			"Inspect the complete, typed contract for the public Zuse website API.",
		href: "/openapi.json",
		label: "Open openapi.json",
	},
	{
		title: "Agent instructions",
		description:
			"Read when an agent should use Zuse, how to discover resources, and current product boundaries.",
		href: "/llms.txt",
		label: "Open llms.txt",
	},
	{
		title: "Local MCP integration",
		description:
			"The open-source MCP server connects compatible clients to the installed Zuse desktop app over stdio.",
		href: "https://github.com/swarajbachu/zuse/tree/main/apps/mcp-server",
		label: "View MCP server source",
	},
];

export default function DevelopersPage() {
	return (
		<main>
			<Container className="py-32 md:py-40">
				<div className="max-w-3xl">
					<p className="text-primary font-mono text-sm font-medium">
						For developers and agents
					</p>
					<h1 className="text-heading mt-3 font-display text-4xl font-semibold tracking-tight text-balance md:text-6xl">
						Zuse developer resources
					</h1>
					<p className="text-muted-foreground mt-6 text-base leading-7 md:text-lg">
						Machine-readable contracts and direct documentation for building
						with, integrating, or accurately describing Zuse.
					</p>
				</div>

				<div className="border-border mt-14 grid border-t md:grid-cols-2">
					{resources.map((resource) => (
						<section
							key={resource.title}
							className="border-border border-b py-8 md:px-8 md:odd:border-r md:odd:pl-0"
						>
							<h2 className="text-heading text-lg font-semibold">
								{resource.title}
							</h2>
							<p className="text-muted-foreground mt-3 text-sm leading-6">
								{resource.description}
							</p>
							<Link
								href={resource.href}
								className="text-primary mt-5 inline-flex text-sm font-medium underline underline-offset-4"
							>
								{resource.label}
							</Link>
						</section>
					))}
				</div>

				<div className="mt-14 grid gap-10 md:grid-cols-3">
					<section>
						<h2 className="text-heading text-base font-semibold">Public API</h2>
						<p className="text-muted-foreground mt-3 text-sm leading-6">
							The public web API currently contains one endpoint for registering
							Zuse Cloud interest. It does not expose repositories or sessions.
						</p>
					</section>
					<section>
						<h2 className="text-heading text-base font-semibold">
							Authentication
						</h2>
						<p className="text-muted-foreground mt-3 text-sm leading-6">
							The waitlist endpoint requires no authentication. Agent-provider
							credentials remain in each developer&apos;s local tools and are
							not part of the public web API.
						</p>
					</section>
					<section>
						<h2 className="text-heading text-base font-semibold">Webhooks</h2>
						<p className="text-muted-foreground mt-3 text-sm leading-6">
							Zuse does not currently publish a webhook API. Any future webhook
							contract will be added to the OpenAPI specification first.
						</p>
					</section>
				</div>
			</Container>
		</main>
	);
}
