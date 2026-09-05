import type { CloudGithubStatus } from "@zuse/contracts";
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
	const installations = status?.installations ?? [];
	const configured = status?.configured ?? true;
	const connected = installations.some(
		(installation) => !installation.suspended,
	);

	return (
		<CloudSettingsGroup
			title="GitHub"
			description="Configure the Zuse GitHub App for your personal account or organizations. Zuse never reads or copies your Mac's GitHub login."
			action={
				connected ? (
					<Button
						size="xs"
						className={COMPACT_CLOUD_ACTION}
						loading={busy === "github-install"}
						onClick={onInstall}
					>
						<GithubMark /> Configure app
					</Button>
				) : (
					<Button
						size="xs"
						className={COMPACT_CLOUD_ACTION}
						disabled={!configured}
						loading={busy === "github-install"}
						onClick={onInstall}
					>
						<GithubMark /> Install GitHub App
					</Button>
				)
			}
		>
			{!configured ? (
				<CloudSettingsRow
					title="GitHub App is not configured"
					description="Add the GitHub App credentials to API, deploy it, then retry."
					action={<Badge variant="error">Unavailable</Badge>}
				/>
			) : installations.length === 0 ? (
				<CloudSettingsRow
					title="Connect repositories"
					description="Start here so the callback is signed and linked to this Zuse account. On GitHub, choose selected repositories."
					action={
						<Button
							size="xs"
							variant="ghost"
							className={COMPACT_CLOUD_ACTION}
							loading={loading}
							onClick={onRefresh}
						>
							<RefreshCw aria-hidden /> Check connection
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
									<Badge variant="warning">Suspended</Badge>
								) : (
									<Badge variant="success">
										<Check aria-hidden /> Connected
									</Badge>
								)}
								<Button
									size="xs"
									variant="ghost"
									className={COMPACT_CLOUD_ACTION}
									onClick={() => onManage(installation.installationId)}
								>
									Repository access
								</Button>
								<Button
									size="icon"
									variant="ghost"
									className={`size-7 ${COMPACT_CLOUD_ACTION}`}
									aria-label={`Disconnect ${installation.accountLogin}`}
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
								{status?.repositories.length ?? 0} repositories available across
								connected installations.
							</span>
						</div>
					</CloudSettingsRow>
				))
			)}
			{connected ? (
				<CloudSettingsRow
					title="Connection status"
					description="Repository changes refresh automatically when you return from GitHub. Existing installations never need to be removed first."
					action={
						<Button
							size="xs"
							variant="ghost"
							className={COMPACT_CLOUD_ACTION}
							loading={loading}
							onClick={onRefresh}
						>
							<RefreshCw aria-hidden /> Refresh
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
