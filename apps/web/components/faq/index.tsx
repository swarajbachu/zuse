import Link from "next/link";
import React from "react";
import { Container } from "@/components/container";
import { Header } from "@/components/header";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@/components/ui/accordion";
import { GITHUB_URL } from "@/lib/site";

const data = [
	{
		question: "Which agents are supported?",
		answer:
			"Zuse wraps seven coding agent CLIs in one workspace: Claude Code, Codex, Cursor, Gemini, Grok, OpenCode, and Kiro. You can run them side by side and switch providers without leaving the app.",
	},
	{
		question: "Do I need my own API keys or subscriptions?",
		answer:
			"Yes. Zuse is bring your own keys. You plug in your own provider keys or subscriptions, and Zuse talks to them directly. It never resells tokens and adds $0 markup, so you only pay the agent providers.",
	},
	{
		question: "Is my code or data sent anywhere?",
		answer:
			"Local and SSH chats stay on the computers you choose. When you use the optional Zuse Cloud private beta, its workspace runs in E2B and encrypted transcript checkpoints are stored for fast reconnects. Model requests go only to the providers you configure. Pseudonymous usage analytics never include prompts, responses, code, paths, commands, account details, or error stacks, and you can turn them off in Settings.",
	},
	{
		question: "Which operating systems are supported?",
		answer:
			"Zuse (Beta) ships for macOS and x64 Linux. The Download button selects the macOS disk image or Linux AppImage automatically, and Debian and Ubuntu users can also get the .deb package from GitHub Releases.",
	},
	{
		question: "How much does it cost?",
		answer:
			"The Zuse desktop beta is available now and uses your own agent subscriptions or API keys. Zuse Cloud is a private, invite-only beta: Cloud Workspace costs $40/month, includes $35 of attributable E2B compute, and bills additional provider cost plus 5% up to your overage cap.",
	},
	{
		question: "Can I run multiple agents at once?",
		answer:
			"Yes. You can run several agents in parallel, each in its own chat with its own git worktree, so their changes stay isolated. Review and commit each one from the PR and Changes pane.",
	},
	{
		question: "What is sub-agent delegation?",
		answer:
			"A lead agent can spawn sub-agents to handle parts of a task, including cheaper models for the simpler work. That keeps the expensive model focused on the hard parts and lowers your overall token cost.",
	},
];

export const FAQ = () => {
	return (
		<section id="faq" className="w-full scroll-mt-24">
			<Container className="grid grid-cols-1 gap-15 py-20 md:py-30 lg:grid-cols-2">
				<div className="flex flex-col gap-4 pt-8">
					<Header>Questions devs ask first</Header>
					<div className="-tracking-xs text-muted-foreground text-base leading-6 font-medium">
						More questions? See the project on{" "}
						<Link
							href={GITHUB_URL}
							target="_blank"
							rel="noopener noreferrer"
							className="text-primary underline underline-offset-3"
						>
							GitHub
						</Link>
						.
					</div>
				</div>
				<div className="h-full w-full">
					<Accordion defaultValue={[data[0].question]}>
						{data.map((item, index) => (
							<React.Fragment key={item.question}>
								<AccordionItem value={item.question} className="py-8">
									<AccordionTrigger className="-tracking-xs text-foreground text-base leading-6 font-medium">
										{item.question}
									</AccordionTrigger>
									<AccordionContent className="text-muted-foreground">
										{item.answer}
									</AccordionContent>
								</AccordionItem>
								{data.length - 1 !== index && (
									<div className="bg-white/10 h-px w-full" />
								)}
							</React.Fragment>
						))}
					</Accordion>
				</div>
			</Container>
		</section>
	);
};
