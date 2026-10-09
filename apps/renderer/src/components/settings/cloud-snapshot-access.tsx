import "@zuse/i18n/english/settings";
import type { CloudAccountImage } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { Badge } from "../ui/badge.tsx";
import {
	CloudProviderTile,
	CloudSettingsGroup,
	CloudSettingsRow,
} from "./cloud-settings-ui.tsx";
import { GithubMark } from "./cloud-workspace-github.tsx";
import { RepositoryAvatar } from "./cloud-workspace-repositories.tsx";

type SnapshotRepository = NonNullable<
	CloudAccountImage["snapshot"]
>["repositories"][number];

const repositoryName = (image: CloudAccountImage, item: SnapshotRepository) =>
	image.repositories.find(
		(repository) => repository.projectId === item.projectId,
	)?.displayName ??
	item.path.split("/").filter(Boolean).at(-1) ??
	item.path;

const SNAPSHOT_AGENTS = [
	{ providerId: "claude", label: "Claude Code" },
	{ providerId: "codex", label: "Codex" },
] as const;

/** GitHub login and repositories found in a custom snapshot, each listed once. */
export function CloudSnapshotRepositories({
	image,
}: {
	readonly image: CloudAccountImage;
}) {
	const { message } = useMessages(["settings"]);
	const repositories = image.snapshot?.repositories ?? [];
	const native = image.snapshot?.gitAuthentication !== "zuse";
	const github = image.snapshot?.github;
	return (
		<CloudSettingsGroup
			title={message("settings:snapshot_repositories_title")}
			action={
				<Badge variant="outline">
					{message(
						native
							? "settings:snapshot_source_snapshot"
							: "settings:snapshot_github_via_zuse",
					)}
				</Badge>
			}
		>
			{native ? (
				<CloudSettingsRow
					leading={
						github?.login === undefined ? (
							<span className="flex size-6 items-center justify-center rounded-md bg-muted">
								<GithubMark />
							</span>
						) : (
							<RepositoryAvatar name={github.login} />
						)
					}
					title={
						github?.login === undefined
							? message("settings:snapshot_github_login")
							: `@${github.login}`
					}
					description={message(
						github === undefined
							? "settings:snapshot_login_unchecked"
							: github.state === "authenticated"
								? "settings:snapshot_github_signed_in"
								: github.state === "missing-tool"
									? "settings:snapshot_github_missing_tool"
									: github.state === "authentication-required"
										? "settings:snapshot_github_signed_out"
										: "settings:snapshot_login_unavailable",
					)}
					action={<LoginBadge state={github?.state} />}
				/>
			) : null}
			{repositories.length === 0 ? (
				<CloudSettingsRow
					title={message("settings:snapshot_no_repositories_title")}
					description={message("settings:snapshot_no_repositories")}
				/>
			) : (
				repositories.map((repository) => {
					const name = repositoryName(image, repository);
					return (
						<CloudSettingsRow
							key={repository.projectId}
							leading={<RepositoryAvatar name={name} />}
							title={name}
							description={
								<>
									<span className="break-all">{repository.path}</span>
									{repository.gitAccess === "readable" ? null : (
										<>
											{" · "}
											{message(
												repository.gitAccess === "authentication-required"
													? native
														? "settings:snapshot_native_git_login"
														: "settings:snapshot_git_login"
													: "settings:snapshot_git_unavailable",
											)}
										</>
									)}
								</>
							}
							action={
								<Badge
									variant={
										repository.gitAccess === "readable" ? "success" : "warning"
									}
								>
									{message(
										repository.gitAccess === "readable"
											? "settings:snapshot_git_ok"
											: "settings:snapshot_git_attention",
									)}
								</Badge>
							}
						/>
					);
				})
			)}
		</CloudSettingsGroup>
	);
}

/** Claude Code and Codex logins found on the snapshot's Linux user. */
export function CloudSnapshotAgentAuthentication({
	image,
}: {
	readonly image: CloudAccountImage;
}) {
	const { message } = useMessages(["settings"]);
	return (
		<CloudSettingsGroup
			title={message("settings:cloud_hosting_agent_auth")}
			action={
				<Badge variant="outline">
					{message("settings:snapshot_source_snapshot")}
				</Badge>
			}
		>
			<p className="px-3 py-2 text-[11px] text-muted-foreground">
				{message("settings:snapshot_inspected_user", {
					user: image.snapshot?.runtimeUser ?? "",
				})}{" "}
				{message("settings:snapshot_native_agents")}
			</p>
			<CloudSnapshotAgentRows image={image} />
		</CloudSettingsGroup>
	);
}

/** One row per agent the snapshot was checked for; rendered inside a settings group. */
export function CloudSnapshotAgentRows({
	image,
}: {
	readonly image: CloudAccountImage;
}) {
	const { message } = useMessages(["settings"]);
	const recorded = image.snapshot?.agents;
	return SNAPSHOT_AGENTS.map((agent) => {
		const access = recorded?.find(
			(item) => item.providerId === agent.providerId,
		);
		return (
			<CloudSettingsRow
				key={agent.providerId}
				leading={<CloudProviderTile providerId={agent.providerId} />}
				title={agent.label}
				description={
					access?.account ??
					message(
						recorded === undefined
							? "settings:snapshot_login_unchecked"
							: access === undefined || access.state === "unavailable"
								? "settings:snapshot_login_unavailable"
								: access.state === "missing-tool"
									? "settings:snapshot_agent_missing_tool"
									: access.state === "verified"
										? "settings:snapshot_agent_signed_in"
										: access.state === "detected"
											? "settings:snapshot_login_detected"
											: "settings:snapshot_agent_signed_out",
					)
				}
				action={<LoginBadge state={access?.state} />}
			/>
		);
	});
}

function LoginBadge({ state }: { readonly state: string | undefined }) {
	const { message } = useMessages(["settings"]);
	if (state === undefined) return null;
	const ok = state === "authenticated" || state === "verified";
	return (
		<Badge
			variant={
				ok
					? "success"
					: state === "missing-tool" || state === "detected"
						? "outline"
						: "warning"
			}
		>
			{message(
				ok
					? "settings:snapshot_login_signed_in"
					: state === "detected"
						? "settings:snapshot_login_detected"
						: state === "missing-tool"
							? "settings:snapshot_login_not_installed"
							: state === "unavailable"
								? "settings:snapshot_login_unknown"
								: "settings:snapshot_login_signed_out",
			)}
		</Badge>
	);
}
