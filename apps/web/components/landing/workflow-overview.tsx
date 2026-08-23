import {
	IconArrowsShuffle,
	IconGitBranch,
	IconGitPullRequest,
} from "@tabler/icons-react";

const steps = [
	{
		number: "01",
		title: "Bring the agents you already use",
		description:
			"Connect your existing coding-agent subscriptions and choose the right provider for each session.",
		icon: IconArrowsShuffle,
	},
	{
		number: "02",
		title: "Run work in parallel",
		description:
			"Give every task its own chat, branch, and git worktree so multiple attempts never overwrite each other.",
		icon: IconGitBranch,
	},
	{
		number: "03",
		title: "Carry context, then review",
		description:
			"Continue with another agent using the plan, transcript, or files it needs, then inspect the diff before anything ships.",
		icon: IconGitPullRequest,
	},
] as const;

export function WorkflowOverview() {
	return (
		<section id="workflow" className="scroll-mt-24 px-4 py-16 md:px-8 md:py-24">
			<header className="mx-auto max-w-3xl text-center">
				<p className="text-primary font-mono text-[11px] font-semibold uppercase tracking-[0.18em]">
					How Zuse works
				</p>
				<h2 className="text-heading mt-3 text-3xl font-semibold tracking-tight text-balance md:text-5xl">
					One repo. Many agents. No lost context.
				</h2>
				<p className="text-muted-foreground mx-auto mt-5 max-w-2xl text-base leading-7 text-pretty md:text-lg">
					Zuse keeps every agent session connected to the code, branch, and
					review state it belongs to.
				</p>
			</header>

			<ol className="border-border bg-border mx-auto mt-12 grid max-w-5xl gap-px overflow-hidden rounded-2xl border md:grid-cols-3">
				{steps.map((step) => {
					const Icon = step.icon;

					return (
						<li key={step.number} className="bg-background p-6 md:p-8">
							<div className="flex items-center justify-between">
								<span className="text-muted-foreground font-mono text-xs">
									{step.number}
								</span>
								<span className="bg-primary/10 text-primary grid size-9 place-items-center rounded-lg">
									<Icon aria-hidden="true" className="size-4.5" />
								</span>
							</div>
							<h3 className="text-heading mt-8 text-lg font-semibold tracking-tight">
								{step.title}
							</h3>
							<p className="text-muted-foreground mt-3 text-sm leading-6">
								{step.description}
							</p>
						</li>
					);
				})}
			</ol>
		</section>
	);
}
