import { formatDate as formatUiDate } from "@zuse/i18n";
import "@zuse/i18n/english/settings";
import type { CloudAccountImageBuildAttempt } from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
import { RichMessage, useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	CircleX,
	LoaderCircle,
} from "lucide-react";
import { useState } from "react";

import { useRelativeTimeTick } from "../../lib/use-relative-time.ts";
import { CopyButton } from "../copy-button.tsx";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { COMPACT_CLOUD_ACTION } from "./cloud-settings-ui.tsx";
import { RepositoryAvatar } from "./cloud-workspace-repositories.tsx";

const PAGE_SIZE = 5;

const formatDuration = (createdAt: number, endAt: number) => {
	const seconds = Math.max(0, Math.round((endAt - createdAt) / 1_000));
	return seconds < 60
		? `${seconds}s`
		: `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

function RunningDuration({ createdAt }: { readonly createdAt: number }) {
	const now = useRelativeTimeTick(1_000);
	return <>{formatDuration(createdAt, now)}</>;
}

const presentation = (state: CloudAccountImageBuildAttempt["state"]) =>
	state === "ready"
		? {
				label: uiMessage("settings:cloud_image_build_history_succeeded"),
				variant: "success" as const,
			}
		: state === "failed"
			? {
					label: uiMessage("settings:cloud_image_build_history_failed"),
					variant: "error" as const,
				}
			: {
					label: uiMessage("settings:cloud_image_build_history_in_progress"),
					variant: "warning" as const,
				};

function BuildIcon({
	state,
}: {
	state: CloudAccountImageBuildAttempt["state"];
}) {
	return state === "ready" ? (
		<CheckCircle2 className="size-3.5 text-success" aria-hidden />
	) : state === "failed" ? (
		<CircleX className="size-3.5 text-destructive" aria-hidden />
	) : (
		<LoaderCircle
			className="size-3.5 animate-spin text-muted-foreground"
			aria-hidden
		/>
	);
}

function BuildAccordion({
	build,
	customSnapshot = build.source === "custom-snapshot",
	defaultOpen = false,
}: {
	readonly build: CloudAccountImageBuildAttempt;
	readonly customSnapshot?: boolean;
	readonly defaultOpen?: boolean;
}) {
	const { message: uiMessage } = useUiMessages(["settings"]);

	const status = presentation(build.state);
	return (
		<details className="group/build" open={defaultOpen}>
			<summary className="flex h-7 cursor-pointer list-none items-center gap-2 px-3 hover:bg-muted/40">
				<BuildIcon state={build.state} />
				<span className="min-w-0 flex-1 truncate text-xs font-medium">
					{customSnapshot
						? uiMessage("settings:snapshot_check_title")
						: build.mode === "rebuild"
							? uiMessage("settings:cloud_image_build_history_clean_rebuild")
							: uiMessage("settings:cloud_image_build_history_image_update")}
				</span>
				<span className="hidden text-[10px] text-muted-foreground sm:inline">
					{formatUiDate(new Date(build.createdAt), {
						year: "numeric",
						month: "numeric",
						day: "numeric",
						hour: "numeric",
						minute: "numeric",
						second: "numeric",
					})}{" "}
					·{" "}
					{build.state === "ready" || build.state === "failed" ? (
						formatDuration(build.createdAt, build.updatedAt)
					) : (
						<RunningDuration createdAt={build.createdAt} />
					)}
				</span>
				{build.active ? (
					<Badge variant="success">
						{uiMessage("settings:cloud_image_build_history_active")}
					</Badge>
				) : null}
				<Badge variant={status.variant}>{status.label}</Badge>
				<ChevronDown className="size-3 text-muted-foreground transition-transform group-open/build:rotate-180" />
			</summary>
			<div className="space-y-2 px-3 py-2">
				{build.state === "sanitizing" ? (
					<p
						className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
						role="status"
					>
						<LoaderCircle className="size-3 animate-spin" aria-hidden />
						{uiMessage("settings:cloud_image_sanitizing")}
					</p>
				) : null}
				<div className="relative rounded-md bg-muted/30 p-2.5">
					<CopyButton
						text={build.logText ?? ""}
						label={uiMessage(
							"settings:cloud_image_build_history_copy_build_logs",
						)}
						className="absolute top-1 right-1 size-7"
					/>
					<pre className="max-h-72 overflow-auto whitespace-pre-wrap pr-8 font-mono text-[10px] leading-4 text-foreground/85">
						{build.logText ||
							(customSnapshot
								? uiMessage(
										build.state === "ready"
											? "settings:snapshot_ready"
											: build.state === "failed"
												? "settings:snapshot_unknown_error"
												: "settings:snapshot_inspecting",
										{ code: build.errorCode ?? "unknown" },
									)
								: build.state === "failed"
									? `Logs were not retained for this older build.\nError: ${build.errorCode ?? "unknown"}`
									: build.state === "sanitizing"
										? "Preparing snapshot…"
										: build.state === "ready"
											? "Build completed. No output was retained."
											: "Waiting for build output…")}
					</pre>
				</div>
				{customSnapshot ? (
					<BuildRepositories build={build} />
				) : (
					<details className="group/settings">
						<summary className="flex h-7 cursor-pointer list-none items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
							<ChevronRight
								className="size-3 transition-transform duration-150 group-open/settings:rotate-90"
								aria-hidden
							/>
							{uiMessage("settings:cloud_image_build_history_build_settings")}
						</summary>
						<div className="space-y-2 pt-1 text-[11px]">
							<div className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5">
								<RichMessage
									id="settings:cloud_image_build_history_runtimerepositoriesagents_sentence"
									values={{
										value: build.runtimeVersion,
										value2: build.repositories.length,
										value3:
											build.providers
												.filter((provider) => provider.state === "connected")
												.map((provider) => provider.providerId)
												.join(", ") || "None",
									}}
									components={{
										part0: <span className="text-muted-foreground" />,
										part1: <span />,
										part2: <span className="text-muted-foreground" />,
										part3: <span />,
										part4: <span className="text-muted-foreground" />,
										part5: <span />,
									}}
								/>
							</div>
							<BuildRepositories build={build} />
						</div>
					</details>
				)}
			</div>
		</details>
	);
}

/** Repositories captured by one build, listed with their branch. */
function BuildRepositories({
	build,
}: {
	readonly build: CloudAccountImageBuildAttempt;
}) {
	if (build.repositories.length === 0) return null;
	return (
		<div className="divide-y divide-border/60 rounded-md bg-muted/30 text-[11px]">
			{build.repositories.map((repository) => (
				<div
					key={repository.projectId}
					className="flex h-8 items-center justify-between gap-3 px-2"
				>
					<span className="flex min-w-0 items-center gap-2">
						<RepositoryAvatar name={repository.displayName} />
						<span className="truncate">{repository.displayName}</span>
					</span>
					<span className="shrink-0 text-[10px] text-muted-foreground">
						{repository.defaultBranch}
					</span>
				</div>
			))}
		</div>
	);
}

export function CloudImageBuildHistory({
	builds,
	expandLatest = false,
	latestSource,
}: {
	readonly builds: ReadonlyArray<CloudAccountImageBuildAttempt>;
	readonly expandLatest?: boolean;
	readonly latestSource?: "managed" | "custom-snapshot";
}) {
	const { message: uiMessage } = useUiMessages(["settings"]);

	const [page, setPage] = useState(0);
	if (builds.length === 0) return null;
	const latest = builds[0];
	if (latest === undefined) return null;
	const previous = builds.slice(1);
	const pageCount = Math.max(1, Math.ceil(previous.length / PAGE_SIZE));
	const safePage = Math.min(page, pageCount - 1);
	const visiblePrevious = previous.slice(
		safePage * PAGE_SIZE,
		(safePage + 1) * PAGE_SIZE,
	);

	return (
		<div>
			<div
				className={
					expandLatest
						? "sr-only"
						: "px-3 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wide"
				}
			>
				{uiMessage("settings:cloud_image_build_history_latest_build")}
			</div>
			<BuildAccordion
				key={latest.buildId}
				build={latest}
				customSnapshot={(latest.source ?? latestSource) === "custom-snapshot"}
				defaultOpen={expandLatest}
			/>
			{previous.length === 0 ? null : (
				<details className="group/history border-border border-t">
					<summary className="flex h-7 cursor-pointer list-none items-center gap-2 px-3 text-[11px] text-muted-foreground hover:text-foreground">
						<ChevronDown className="size-3 transition-transform group-open/history:rotate-180" />
						{uiMessage("settings:cloud_image_build_history_previous_builds")}
						{previous.length}
					</summary>
					<div className="divide-y divide-border/60 border-border border-t">
						{visiblePrevious.map((build) => (
							<BuildAccordion key={build.buildId} build={build} />
						))}
						{pageCount <= 1 ? null : (
							<div className="flex h-9 items-center justify-between px-3">
								<span className="text-[10px] text-muted-foreground">
									{uiMessage(
										"settings:cloud_image_build_history_page_of_sentence",
										{ value: safePage + 1, pageCount: pageCount },
									)}
								</span>
								<div className="flex gap-1">
									<Button
										size="lg"
										variant="ghost"
										className={`${COMPACT_CLOUD_ACTION} text-[11px]`}
										disabled={safePage === 0}
										onClick={() =>
											setPage((current) => Math.max(0, current - 1))
										}
									>
										{uiMessage("settings:cloud_image_build_history_previous")}
									</Button>
									<Button
										size="lg"
										variant="ghost"
										className={`${COMPACT_CLOUD_ACTION} text-[11px]`}
										disabled={safePage >= pageCount - 1}
										onClick={() =>
											setPage((current) => Math.min(pageCount - 1, current + 1))
										}
									>
										{uiMessage("settings:cloud_image_build_history_next")}
									</Button>
								</div>
							</div>
						)}
					</div>
				</details>
			)}
		</div>
	);
}
