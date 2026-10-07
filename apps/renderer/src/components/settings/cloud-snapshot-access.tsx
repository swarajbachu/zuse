import "@zuse/i18n/english/settings";
import type { CloudAccountImage } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { Badge } from "../ui/badge.tsx";
import { CloudSettingsGroup, CloudSettingsRow } from "./cloud-settings-ui.tsx";

type SnapshotRepository = NonNullable<
	CloudAccountImage["snapshot"]
>["repositories"][number];

const repositoryName = (image: CloudAccountImage, item: SnapshotRepository) =>
	image.repositories.find(
		(repository) => repository.projectId === item.projectId,
	)?.displayName ??
	item.path.split("/").filter(Boolean).at(-1) ??
	item.path;

/** Repositories found in a custom snapshot, listed once with their Git access. */
export function CloudSnapshotRepositories({
	image,
}: {
	readonly image: CloudAccountImage;
}) {
	const { message } = useMessages(["settings"]);
	const repositories = image.snapshot?.repositories ?? [];
	return (
		<CloudSettingsGroup
			title={message("settings:snapshot_repositories_title")}
			action={
				<Badge variant="outline">
					{message(
						image.snapshot?.gitAuthentication === "zuse"
							? "settings:snapshot_github_via_zuse"
							: "settings:snapshot_source_snapshot",
					)}
				</Badge>
			}
		>
			{repositories.length === 0 ? (
				<CloudSettingsRow
					title={message("settings:snapshot_no_repositories_title")}
					description={message("settings:snapshot_no_repositories")}
				/>
			) : (
				repositories.map((repository) => (
					<CloudSettingsRow
						key={repository.projectId}
						title={repositoryName(image, repository)}
						description={
							repository.gitAccess === "readable" ? (
								<span className="break-all">{repository.path}</span>
							) : (
								<>
									<span className="break-all">{repository.path}</span>
									{" · "}
									{message(
										repository.gitAccess === "authentication-required"
											? image.snapshot?.gitAuthentication === "zuse"
												? "settings:snapshot_git_login"
												: "settings:snapshot_native_git_login"
											: "settings:snapshot_git_unavailable",
									)}
								</>
							)
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
				))
			)}
		</CloudSettingsGroup>
	);
}

/** Agents sign in with the logins already on the snapshot's Linux user. */
export function CloudSnapshotAgentAuthentication() {
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
			<CloudSettingsRow
				title={message("settings:snapshot_native_credentials_title")}
				description={message("settings:snapshot_native_agents")}
			/>
		</CloudSettingsGroup>
	);
}
