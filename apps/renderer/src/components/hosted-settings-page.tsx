import { useState } from "react";
import { useAuth } from "../hooks/use-auth.ts";
import { refreshHostedProjects } from "../lib/hosted-workspace.ts";
import { useSettingsStore } from "../lib/settings-client-bus.ts";
import { useUiStore } from "../store/ui.ts";
import { CloudWorkspacePool } from "./settings/cloud-workspace-pool.tsx";
import { DefaultModelsPane } from "./settings-page.tsx";
import { Button } from "./ui/button.tsx";

export function HostedSettingsPage() {
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
					Back to chats
				</Button>
				<h1 className="text-sm font-medium">Settings</h1>
			</header>
			<nav aria-label="Settings" className="flex gap-2 px-5 pb-3">
				{(
					[
						["cloud", "Cloud agents"],
						["preferences", "Preferences"],
						["account", "Account"],
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
								Appearance
								<select
									className="h-7 rounded bg-muted px-2"
									value={settings.appearanceMode}
									onChange={(e) =>
										settings.setAppearanceMode(
											e.target.value as typeof settings.appearanceMode,
										)
									}
								>
									<option value="system">System</option>
									<option value="light">Light</option>
									<option value="dark">Dark</option>
								</select>
							</label>
							<DefaultModelsPane />
							<p className="text-muted-foreground">
								Browser preferences are saved for this account on this browser.
							</p>
						</div>
					)}
					{tab === "account" && (
						<div className="space-y-3 text-sm">
							<p>{auth.name}</p>
							<p className="text-xs text-muted-foreground">
								Billing and usage are available under Cloud agents.
							</p>
							<Button
								className="h-7"
								variant="secondary"
								onClick={() => void auth.signOut()}
							>
								Sign out
							</Button>
						</div>
					)}
				</div>
			</main>
		</div>
	);
}
