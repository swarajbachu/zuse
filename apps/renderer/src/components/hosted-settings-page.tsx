import "@zuse/i18n/english/shell";
import "@zuse/i18n/english/settings";
import "@zuse/i18n/english/common";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { useState } from "react";
import { useAuth } from "../hooks/use-auth.ts";
import { refreshHostedProjects } from "../lib/hosted-workspace.ts";
import { useSettingsStore } from "../lib/settings-client-bus.ts";
import { useUiStore } from "../store/ui.ts";
import { CloudWorkspacePool } from "./settings/cloud-workspace-pool.tsx";
import { DefaultModelsPane } from "./settings-page.tsx";
import { Button } from "./ui/button.tsx";

export function HostedSettingsPage() {
	const { message: uiMessage } = useUiMessages(["common", "settings", "shell"]);
	const [tab, setTab] = useState<"cloud" | "preferences" | "account">("cloud");
	const settings = useSettingsStore((s) => s);
	const auth = useAuth();
	const back = () => {
		void refreshHostedProjects(true).catch(() => undefined);
		useUiStore.getState().setView("chat");
	};
	return (
		<div className="flex h-full w-full flex-col overflow-hidden">
			<header className="flex items-center gap-4 px-5 py-3">
				<Button className="h-7" variant="ghost" onClick={back}>
					{uiMessage("shell:hosted_back_to_chats")}
				</Button>
				<h1 className="text-sm font-medium">{uiMessage("common:settings")}</h1>
			</header>
			<nav
				aria-label={uiMessage("common:settings")}
				className="flex gap-2 px-5 pb-3"
			>
				{(
					[
						["cloud", uiMessage("shell:hosted_cloud_agents")],
						["preferences", uiMessage("shell:hosted_preferences")],
						["account", uiMessage("settings:settings_page_account")],
					] as const
				).map(([id, label]) => (
					<Button
						className="h-7"
						key={id}
						variant={tab === id ? "secondary" : "ghost"}
						onClick={() => setTab(id)}
					>
						{label}
					</Button>
				))}
			</nav>
			<main className="min-h-0 flex-1 overflow-auto px-5 pb-8">
				<div className="mx-auto max-w-4xl space-y-4">
					{tab === "cloud" && <CloudWorkspacePool />}
					{tab === "preferences" && (
						<div className="max-w-md space-y-4 text-xs">
							<label className="flex items-center justify-between gap-4">
								{uiMessage("settings:settings_page_appearance")}
								<select
									className="h-7 rounded bg-muted px-2"
									value={settings.appearanceMode}
									onChange={(e) =>
										settings.setAppearanceMode(
											e.target.value as typeof settings.appearanceMode,
										)
									}
								>
									<option value="system">{uiMessage("common:system")}</option>
									<option value="light">
										{uiMessage("settings:settings_page_light")}
									</option>
									<option value="dark">
										{uiMessage("settings:settings_page_dark")}
									</option>
								</select>
							</label>
							<DefaultModelsPane />
							<p className="text-muted-foreground">
								{uiMessage(
									"shell:hosted_browser_preferences_are_saved_for_this_account_on_this_browser",
								)}
							</p>
						</div>
					)}
					{tab === "account" && (
						<div className="space-y-3 text-sm">
							<p>{auth.name}</p>
							<p className="text-xs text-muted-foreground">
								{uiMessage(
									"shell:hosted_billing_and_usage_are_available_under_cloud_agents",
								)}
							</p>
							<Button
								className="h-7"
								variant="secondary"
								onClick={() => void auth.signOut()}
							>
								{uiMessage("common:signOut")}
							</Button>
						</div>
					)}
				</div>
			</main>
		</div>
	);
}
