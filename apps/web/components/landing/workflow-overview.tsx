"use client";
import {
	IconArrowsShuffle,
	IconGitBranch,
	IconGitPullRequest,
} from "@tabler/icons-react";
import {
	useWebsiteMessages,
	type WebsiteMessage,
} from "@zuse/i18n/website/react";

const getSteps = (t: WebsiteMessage) =>
	[
		{
			number: "01",
			title: t("showcase:bring_the_agents_you_already_use"),
			description: t(
				"showcase:connect_your_existing_coding_agent_subscriptions_and_choose_the_right",
			),
			icon: IconArrowsShuffle,
		},
		{
			number: "02",
			title: t("showcase:run_work_in_parallel"),
			description: t(
				"showcase:give_every_task_its_own_chat_branch_and_git_worktree_so_multiple_attem",
			),
			icon: IconGitBranch,
		},
		{
			number: "03",
			title: t("showcase:carry_context_then_review"),
			description: t(
				"showcase:continue_with_another_agent_using_the_plan_transcript_or_files_it_need",
			),
			icon: IconGitPullRequest,
		},
	] as const;

export function WorkflowOverview() {
	const { message: t } = useWebsiteMessages();

	return (
		<section id="workflow" className="scroll-mt-24 px-4 py-16 md:px-8 md:py-24">
			<header className="mx-auto max-w-3xl text-center">
				<p className="text-primary font-mono text-[11px] font-semibold uppercase tracking-[0.18em]">
					{t("showcase:how_zuse_works")}
				</p>
				<h2 className="text-heading mt-3 text-3xl font-semibold tracking-tight text-balance md:text-5xl">
					{t("showcase:one_repo_many_agents_no_lost_context")}
				</h2>
				<p className="text-muted-foreground mx-auto mt-5 max-w-2xl text-base leading-7 text-pretty md:text-lg">
					{t(
						"showcase:zuse_keeps_every_agent_session_connected_to_the_code_branch_and_review",
					)}
				</p>
			</header>

			<ol className="border-border bg-border mx-auto mt-12 grid max-w-5xl gap-px overflow-hidden rounded-2xl border md:grid-cols-3">
				{getSteps(t).map((step) => {
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
