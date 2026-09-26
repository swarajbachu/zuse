import Link from "next/link";
import { Container } from "@/components/container";
import { getSEO } from "@/lib/seo";
export const metadata = getSEO({
	title: "Extensions Preview",
	description:
		"Bring your project’s tools into Zuse. Inspect test failures, browse team procedures, and turn unfinished code into your next agent task.",
	path: "/extensions",
});
const tools = [
	{
		name: "Test Reports",
		id: "test-reports",
		description: "Turn a local JUnit report into a focused debugging prompt.",
		workflow: "Select a report → inspect failures → attach selected tests.",
		files: "JUnit XML",
		surface: "Workspace tab and attachment picker",
	},
	{
		name: "Project Playbook",
		id: "project-playbook",
		description:
			"Give your agent the team procedure that applies to this task.",
		workflow:
			"Select a Markdown document → browse sections → attach the relevant checklist.",
		files: "Repository Markdown",
		surface: "Workspace tab and attachment picker",
	},
	{
		name: "Code Follow-ups",
		id: "code-follow-ups",
		description: "Turn TODO and FIXME comments into actionable work.",
		workflow:
			"Scan your workspace → review code context → attach related findings.",
		files: "Workspace text files",
		surface: "Workspace tab, command palette, and attachment picker",
	},
];
export default function ExtensionsPage() {
	return (
		<main>
			<Container className="py-32 md:py-40">
				<p className="text-primary font-mono text-sm">
					Local desktop preview · release preparation
				</p>
				<h1 className="text-heading mt-3 max-w-4xl font-display text-4xl font-semibold tracking-tight md:text-6xl">
					Bring your project’s tools into Zuse.
				</h1>
				<p className="text-muted-foreground mt-6 max-w-2xl text-lg leading-8">
					Inspect test failures, browse team procedures, and turn unfinished
					code into your next agent task. Install one tool, two, or all three.
				</p>
				<div className="mt-14 grid gap-10 md:grid-cols-3">
					{tools.map((tool) => (
						<section key={tool.name}>
							<h2 className="text-heading text-xl font-semibold">
								{tool.name}
							</h2>
							<p className="mt-3 leading-7">{tool.description}</p>
							<p className="text-muted-foreground mt-4 text-sm leading-6">
								{tool.workflow}
							</p>
							<p className="text-muted-foreground mt-3 text-xs">
								{tool.files} · {tool.surface}
							</p>
						</section>
					))}
				</div>
				<div className="mt-16 space-y-12">
					{tools.map((tool) => (
						<figure key={tool.id}>
							<video
								className="w-full rounded-lg"
								controls
								preload="none"
								poster={`/extensions/demos/${tool.id}.png`}
								aria-label={`${tool.name}: ${tool.workflow}`}
							>
								<source
									src={`/extensions/demos/${tool.id}.webm`}
									type="video/webm"
								/>
								<track
									kind="captions"
									src={`/extensions/demos/${tool.id}.vtt`}
									srcLang="en"
									label="English"
									default
								/>
							</video>
							<figcaption className="mt-3 text-sm text-muted-foreground">
								{tool.name}: {tool.workflow} Recorded in an unsigned Linux
								desktop package using fixture data.
							</figcaption>
						</figure>
					))}
				</div>
				<div className="mt-16 max-w-3xl space-y-4 text-sm leading-7">
					<h2 className="text-heading text-xl font-semibold">
						You choose what becomes context.
					</h2>
					<p>
						Browse locally, preview the text, then attach it to your ordinary
						conversation. Nothing is sent to an AI service while browsing. Your
						chosen agent receives selected context when you submit your prompt.
					</p>
					<p>
						Extensions are opt-in, trusted, unsandboxed code. This preview is
						for local desktop workspaces. Agent plugins, authenticated service
						integrations, ACP catalogs, cloud execution, and mobile panels are
						separate future releases.
					</p>
					<p>
						Public catalog installation is pending release signing and packaged
						desktop verification. No automatic installation or enablement.
					</p>
					<Link
						className="text-primary underline underline-offset-4"
						href="https://docs.zuse.sh/extensions"
					>
						Read the installation and authoring guides
					</Link>
				</div>
			</Container>
		</main>
	);
}
