import "@zuse/i18n/english/settings";
import type { CloudGithubStatus } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Check, RefreshCw, X } from "lucide-react";
import { GITHUB_LOGO_PATH } from "~/lib/github-logo";

import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import {
	CloudSettingsGroup,
	CloudSettingsRow,
	COMPACT_CLOUD_ACTION,
} from "./cloud-settings-ui.tsx";

export function CloudWorkspaceGithub({
	status,
	loading,
	busy,
	onInstall,
	onManage,
	onRefresh,
	onDisconnect,
}: {
	readonly status: CloudGithubStatus | null;
	readonly loading: boolean;
	readonly busy: string | null;
	readonly onInstall: () => void;
	readonly onManage: (installationId: number) => void;
	readonly onRefresh: () => void;
	readonly onDisconnect: (installationId: number) => void;
}) {
	const { message: uiMessage } = useUiMessages(["settings"]);

	const installations = status?.installations ?? [];
	const configured = status?.configured ?? true;
	const connected = installations.some(
		(installation) => !installation.suspended,
	);

	return (
		<CloudSettingsGroup
			title={uiMessage("settings:cloud_workspace_github_github")}
			description={uiMessage(
				"settings:cloud_workspace_github_configure_the_zuse_github_app_for_your_personal_account_or_organizatio",
			)}
			action={
				connected ? (
					<Button
						size="xs"
						className={COMPACT_CLOUD_ACTION}
						loading={busy === "github-install"}
						onClick={onInstall}
					>
						<GithubMark />
						{uiMessage("settings:cloud_workspace_github_configure_app")}
					</Button>
				) : (
					<Button
						size="xs"
						className={COMPACT_CLOUD_ACTION}
						disabled={!configured}
						loading={busy === "github-install"}
						onClick={onInstall}
					>
						<GithubMark />
						{uiMessage("settings:cloud_workspace_github_install_github_app")}
					</Button>
				)
			}
		>
			{!configured ? (
				<CloudSettingsRow
					title={uiMessage(
						"settings:cloud_workspace_github_github_app_is_not_configured",
					)}
					description={uiMessage(
						"settings:cloud_workspace_github_add_the_github_app_credentials_to_api_deploy_it_then_retry",
					)}
					action={
						<Badge variant="error">
							{uiMessage("settings:cloud_workspace_github_unavailable")}
						</Badge>
					}
				/>
			) : installations.length === 0 ? (
				<CloudSettingsRow
					title={uiMessage(
						"settings:cloud_workspace_github_connect_repositories",
					)}
					description={uiMessage(
						"settings:cloud_workspace_github_start_here_so_the_callback_is_signed_and_linked_to_this_zuse_account_o",
					)}
					action={
						<Button
							size="xs"
							variant="ghost"
							className={COMPACT_CLOUD_ACTION}
							loading={loading}
							onClick={onRefresh}
						>
							<RefreshCw aria-hidden />
							{uiMessage("settings:cloud_workspace_github_check_connection")}
						</Button>
					}
				/>
			) : (
				installations.map((installation) => (
					<CloudSettingsRow
						key={installation.installationId}
						title={installation.accountLogin}
						description={`${installation.accountType} · ${installation.repositorySelection === "selected" ? "selected repositories" : "all repositories"}`}
						action={
							<>
								{installation.suspended ? (
									<Badge variant="warning">
										{uiMessage("settings:cloud_workspace_github_suspended")}
									</Badge>
								) : (
									<Badge variant="success">
										<Check aria-hidden />
										{uiMessage("settings:cloud_workspace_github_connected")}
									</Badge>
								)}
								<Button
									size="xs"
									variant="ghost"
									className={COMPACT_CLOUD_ACTION}
									onClick={() => onManage(installation.installationId)}
								>
									{uiMessage(
										"settings:cloud_workspace_github_repository_access",
									)}
								</Button>
								<Button
									size="icon"
									variant="ghost"
									className={`size-7 ${COMPACT_CLOUD_ACTION}`}
									aria-label={uiMessage(
										"settings:cloud_workspace_github_disconnect",
										{ value1: String(installation.accountLogin) },
									)}
									loading={
										busy === `github-disconnect:${installation.installationId}`
									}
									onClick={() => onDisconnect(installation.installationId)}
								>
									<X aria-hidden />
								</Button>
							</>
						}
					>
						<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
							{installation.avatarUrl === undefined ? (
								<GithubMark className="size-5" />
							) : (
								<img
									src={installation.avatarUrl}
									alt=""
									className="size-5 rounded-md"
									referrerPolicy="no-referrer"
								/>
							)}
							<span>
								{uiMessage(
									"settings:cloud_workspace_github_repositories_available_across_connected_installations_sentence",
									{ value: status?.repositories.length ?? 0 },
								)}
							</span>
						</div>
					</CloudSettingsRow>
				))
			)}
			{connected ? (
				<CloudSettingsRow
					title={uiMessage("settings:cloud_workspace_github_connection_status")}
					description={uiMessage(
						"settings:cloud_workspace_github_repository_changes_refresh_automatically_when_you_return_from_github_e",
					)}
					action={
						<Button
							size="xs"
							variant="ghost"
							className={COMPACT_CLOUD_ACTION}
							loading={loading}
							onClick={onRefresh}
						>
							<RefreshCw aria-hidden />
							{uiMessage("settings:cloud_workspace_github_refresh")}
						</Button>
					}
				/>
			) : null}
		</CloudSettingsGroup>
	);
}

function GithubMark({
	className = "size-3.5",
}: {
	readonly className?: string;
}) {
	return (
		<svg
			aria-hidden="true"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d={GITHUB_LOGO_PATH} />
		</svg>
	);
}
