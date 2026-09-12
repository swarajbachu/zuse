import "@zuse/i18n/english/onboarding";
import { RichMessage, useMessages as useUiMessages } from "@zuse/i18n/react";
import { LanguageSelector } from "../../language-selector.tsx";
export function WelcomeStep() {
	const { message: uiMessage } = useUiMessages(["onboarding"]);

	return (
		<div className="flex h-full flex-col gap-10">
			<LanguageSelector />
			<div className="flex flex-col gap-3">
				<span className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground/80">
					{uiMessage("onboarding:welcome_welcome_to_zuse_beta")}
				</span>
				<h1 className="text-4xl font-semibold leading-[1.05] tracking-tight text-foreground">
					<RichMessage
						id="onboarding:welcome_every_agent_one_workspace_sentence"
						components={{ part0: <br /> }}
					/>
				</h1>
				<p className="max-w-md pt-1 text-[15px] leading-relaxed text-muted-foreground">
					{uiMessage(
						"onboarding:welcome_run_claude_codex_grok_and_more_on_your_repos_side_by_side",
					)}
				</p>
			</div>

			<ul className="flex flex-col gap-0.5 text-sm">
				<Row title={uiMessage("onboarding:welcome_credentials_stay_local")}>
					{uiMessage(
						"onboarding:welcome_reuses_supported_cli_auth_or_api_keys_stored_in_your_os_keychain",
					)}
				</Row>
				<Row title={uiMessage("onboarding:welcome_a_worktree_per_chat")}>
					{uiMessage("onboarding:welcome_each_agent_runs_on_its_own_branch")}
				</Row>
				<Row title={uiMessage("onboarding:welcome_built_for_token_maxers")}>
					{uiMessage(
						"onboarding:welcome_run_agents_in_parallel_get_more_from_every_plan",
					)}
				</Row>
			</ul>
		</div>
	);
}

function Row({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<li className="flex items-baseline gap-3 py-2">
			<span className="flex size-1 shrink-0 translate-y-[-3px] rounded-full bg-foreground/40" />
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="font-medium text-foreground">{title}</span>
				<span className="text-xs leading-snug text-muted-foreground">
					{children}
				</span>
			</span>
		</li>
	);
}
