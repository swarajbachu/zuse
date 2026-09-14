import { formatDate as formatUiDate } from "@zuse/i18n";
import "@zuse/i18n/english/settings";
import type { CloudAccountImageBuildAttempt } from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
import { RichMessage, useMessages as useUiMessages } from "@zuse/i18n/react";
import { CheckCircle2, ChevronDown, CircleX, LoaderCircle } from "lucide-react";
import { useState } from "react";

import { CopyButton } from "../copy-button.tsx";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { COMPACT_CLOUD_ACTION } from "./cloud-settings-ui.tsx";

const PAGE_SIZE = 5;

const formatDuration = (build: CloudAccountImageBuildAttempt) => {
	const seconds = Math.max(
		0,
		Math.round((build.updatedAt - build.createdAt) / 1_000),
	);
	return seconds < 60
		? `${seconds}s`
		: `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

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
	defaultOpen = false,
}: {
	readonly build: CloudAccountImageBuildAttempt;
	readonly defaultOpen?: boolean;
}) {
	const { message: uiMessage } = useUiMessages(["settings"]);

	const status = presentation(build.state);
	return (
		<details className="group/build" open={defaultOpen}>
			<summary className="flex h-9 cursor-pointer list-none items-center gap-2 px-3 hover:bg-muted/40">
				<BuildIcon state={build.state} />
				<span className="min-w-0 flex-1 truncate text-xs font-medium">
					{build.mode === "rebuild"
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
					· {formatDuration(build)}
				</span>
				{build.active ? (
					<Badge variant="success">
						{uiMessage("settings:cloud_image_build_history_active")}
					</Badge>
				) : null}
				<Badge variant={status.variant}>{status.label}</Badge>
				<ChevronDown className="size-3 text-muted-foreground transition-transform group-open/build:rotate-180" />
			</summary>
			<div className="space-y-3 bg-muted/20 px-3 py-3">
				<div className="relative rounded-md bg-background/60 p-3">
					<CopyButton
						text={build.logText ?? ""}
						label={uiMessage(
							"settings:cloud_image_build_history_copy_build_logs",
						)}
						className="absolute top-2 right-2 size-7"
					/>
					<pre className="max-h-72 overflow-auto whitespace-pre-wrap pr-8 font-mono text-[10px] leading-4 text-foreground/85">
						{build.logText ||
							(build.state === "failed"
								? `Logs were not retained for this older build.\nError: ${build.errorCode ?? "unknown"}`
								: "Waiting for build output…")}
					</pre>
				</div>
				<details>
					<summary className="cursor-pointer text-[11px] font-medium text-muted-foreground hover:text-foreground">
						{uiMessage("settings:cloud_image_build_history_build_settings")}
					</summary>
					<div className="mt-2 space-y-2 text-[11px]">
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
						<div className="divide-y divide-border/60 rounded-md bg-background/50">
							{build.repositories.map((repository) => (
								<div
									key={repository.projectId}
									className="flex h-7 items-center justify-between gap-3 px-3"
								>
									<span className="truncate">{repository.displayName}</span>
									<span className="shrink-0 text-[10px] text-muted-foreground">
										{repository.defaultBranch}
									</span>
								</div>
							))}
						</div>
					</div>
				</details>
			</div>
		</details>
	);
}

export function CloudImageBuildHistory({
	builds,
}: {
	readonly builds: ReadonlyArray<CloudAccountImageBuildAttempt>;
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
		<div className="border-border border-t">
			<div className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
				{uiMessage("settings:cloud_image_build_history_latest_build")}
			</div>
			<BuildAccordion build={latest} />
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
