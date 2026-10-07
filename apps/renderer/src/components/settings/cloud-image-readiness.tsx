import "@zuse/i18n/english/settings";
import type { CloudAccountImage, CloudProject } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { AlertTriangle, CircleX, LoaderCircle, RefreshCw } from "lucide-react";

import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import {
	CloudSettingsRow,
	COMPACT_CLOUD_ACTION,
} from "./cloud-settings-ui.tsx";

export const cloudImageChangeSummary = (
	image: CloudAccountImage,
	projects: ReadonlyArray<CloudProject>,
): ReadonlyArray<string> => {
	if (image.state === "auth-broken") return ["agent authentication"];
	if (image.state !== "outdated") return [];

	const activeBuild = image.builds.find((build) => build.active);
	const activeProjectIds = new Set(
		activeBuild?.repositories.map((repository) => repository.projectId) ?? [],
	);
	const repositoriesChanged =
		activeProjectIds.size !== projects.length ||
		projects.some(
			(project) =>
				!activeProjectIds.has(project.projectId) ||
				(image.builtAt !== undefined && project.updatedAt > image.builtAt),
		);
	const authenticationChanged = image.providers.some(
		(provider) =>
			image.providerAuthDeliveryVersion !== 1 &&
			!(
				image.codexAuthDeliveryVersion === 1 && provider.providerId === "codex"
			) &&
			provider.verifiedAt !== undefined &&
			image.builtAt !== undefined &&
			provider.verifiedAt > image.builtAt,
	);
	const changes: string[] = [];
	if (repositoriesChanged) changes.push("repositories");
	if (authenticationChanged) changes.push("agent authentication");
	if (changes.length === 0) changes.push("runtime or toolchain");
	return changes;
};

export function CloudImageReadiness({
	image,
	projects,
	busy,
	unavailable,
	onBuild,
	allProviders = false,
}: {
	readonly allProviders?: boolean;
	readonly image: CloudAccountImage | null;
	readonly projects: ReadonlyArray<CloudProject>;
	readonly busy: string | null;
	readonly unavailable: boolean;
	readonly onBuild: (mode: "update" | "rebuild") => void;
}) {
	const { message: uiMessage } = useUiMessages(["settings"]);

	const state = image?.state ?? "not-built";
	const starting = busy === "image:update" || busy === "image:rebuild";
	const building = state === "building" || starting;
	const disabled =
		busy !== null ||
		image === null ||
		projects.length === 0 ||
		unavailable ||
		building ||
		state === "auth-broken";

	if (image === null)
		return (
			<CloudSettingsRow
				title={
					unavailable
						? uiMessage("settings:cloud_image_status_unavailable")
						: uiMessage("settings:cloud_image_checking")
				}
				description={uiMessage("settings:cloud_image_checking_description")}
			/>
		);

	if (image.source === "custom-snapshot" || image.snapshot !== undefined)
		return (
			<CloudSettingsRow
				title={
					building
						? uiMessage("settings:snapshot_checking")
						: state === "ready"
							? uiMessage("settings:snapshot_ready")
							: uiMessage("settings:snapshot_attention")
				}
				description={
					building
						? uiMessage("settings:snapshot_discovering")
						: uiMessage("settings:snapshot_manage_hint")
				}
				action={
					<Badge variant={state === "ready" ? "success" : "warning"}>
						{state}
					</Badge>
				}
			/>
		);
	if (state === "ready" && !starting) {
		return (
			<CloudSettingsRow
				title={uiMessage("settings:cloud_image_readiness_cloud_image_ready")}
				description={
					allProviders
						? uiMessage("settings:cloud_images_all_description")
						: image.providerAuthDeliveryVersion === 1
							? uiMessage("settings:cloud_image_auth_live")
							: uiMessage("settings:cloud_image_auth_legacy")
				}
				action={
					<>
						<Badge variant="success">
							{uiMessage("settings:cloud_image_readiness_ready")}
						</Badge>
						<Button
							size="lg"
							variant="ghost"
							className={`${COMPACT_CLOUD_ACTION} text-[11px]`}
							loading={busy === "image:rebuild"}
							disabled={disabled}
							onClick={() => onBuild("rebuild")}
						>
							{uiMessage("settings:cloud_image_readiness_rebuild")}
						</Button>
					</>
				}
			/>
		);
	}

	if (building) {
		return (
			<div
				role="status"
				className="flex items-center gap-2.5 bg-muted/30 px-3 py-2"
			>
				<LoaderCircle
					className="size-3 shrink-0 animate-spin text-muted-foreground"
					aria-hidden
				/>
				<div className="min-w-0 flex-1">
					<p className="text-xs font-medium">
						{starting && state !== "building"
							? uiMessage("settings:cloud_image_starting")
							: uiMessage(
									"settings:cloud_image_readiness_building_cloud_image",
								)}
					</p>
					<p className="mt-0.5 text-[11px] text-muted-foreground">
						{image.progressPhase === "queued"
							? uiMessage("settings:cloud_image_queued")
							: image.progressPhase === "sanitizing"
								? uiMessage("settings:cloud_image_sanitizing")
								: uiMessage(
										"settings:cloud_image_readiness_preparing_repositories_and_agents",
									)}
					</p>
				</div>
			</div>
		);
	}

	const changes =
		image === null ? [] : cloudImageChangeSummary(image, projects);
	const authenticationChanged = changes.includes("agent authentication");
	const requiresRebuild = state === "auth-broken" || authenticationChanged;
	const failed = state === "failed";
	const notBuilt = state === "not-built";
	const title = failed
		? "Cloud image build failed"
		: notBuilt
			? "Cloud image required"
			: requiresRebuild
				? "Rebuild required"
				: "Unbuilt changes";
	const description = failed
		? `The previous image remains available. ${image?.errorCode ?? "Open the latest build for details."}`
		: notBuilt
			? projects.length === 0
				? "Add a repository before building your first cloud image."
				: `${projects.length} ${projects.length === 1 ? "repository is" : "repositories are"} ready to include.`
			: state === "auth-broken"
				? "Reconnect the affected agent in Step 2. Image status will refresh automatically and show whether a rebuild is needed."
				: `Changed: ${changes.join(", ")}.`;
	const mode =
		allProviders || requiresRebuild
			? "rebuild"
			: (image?.buildMode ?? "update");
	const actionLabel = allProviders
		? uiMessage("settings:cloud_image_readiness_rebuild")
		: notBuilt
			? "Build image"
			: requiresRebuild
				? "Rebuild image"
				: failed
					? "Retry build"
					: "Update image";

	return (
		<div
			className={
				failed || state === "auth-broken"
					? "flex items-center gap-2 bg-alert-error-bg px-3 py-2"
					: "flex items-center gap-2 bg-alert-warning-bg px-3 py-2"
			}
		>
			{failed ? (
				<CircleX className="size-4 shrink-0 text-destructive" aria-hidden />
			) : (
				<AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden />
			)}
			<div className="min-w-0 flex-1">
				<p className="text-xs font-medium">{title}</p>
				<p className="mt-0.5 text-[11px] text-muted-foreground">
					{description}
				</p>
			</div>
			{state === "auth-broken" ? (
				<Badge variant="error">
					{uiMessage("settings:cloud_image_readiness_authentication")}
				</Badge>
			) : null}
			<Button
				size="lg"
				className={`${COMPACT_CLOUD_ACTION} text-[11px]`}
				loading={busy === `image:${mode}`}
				disabled={disabled}
				onClick={() => onBuild(mode)}
			>
				<RefreshCw className="size-3.5" aria-hidden />
				{actionLabel}
			</Button>
		</div>
	);
}
