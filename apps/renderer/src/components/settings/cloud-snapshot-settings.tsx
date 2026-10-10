import "@zuse/i18n/english/common";
import "@zuse/i18n/english/settings";
import type { CloudAccountImage } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { ChevronRight, Info } from "lucide-react";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { cn } from "~/lib/utils";
import { refreshCloudImages } from "../../lib/cloud-image-monitor.ts";
import {
	loadCloudImage,
	peekCloudImage,
} from "../../lib/cloud-workspace-session-cache.ts";
import { runCloudControl } from "../../lib/control-plane-client.ts";
import { Button } from "../ui/button.tsx";
import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "../ui/collapsible.tsx";
import { Input } from "../ui/input.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip.tsx";
import { COMPACT_CLOUD_ACTION } from "./cloud-settings-ui.tsx";
import { CloudSnapshotAuthPanel } from "./cloud-snapshot-auth-panel.tsx";
import { CloudWorkspaceAuth } from "./cloud-workspace-auth.tsx";
import { DeviceCode } from "./connection-login-steps.tsx";

export const SNAPSHOT_INSTALL_COMMAND = "npx zusehq snapshot install";

/** Edit snapshot drafts, or refresh hidden fields before applying an authentication-only change. */
export function CloudSnapshotSettings({
	connectionId,
	authenticationOnly = false,
	onChanged,
}: {
	readonly connectionId: string;
	readonly authenticationOnly?: boolean;
	readonly onChanged: () => Promise<void>;
}) {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);
	const fieldId = useId();
	const [cachedImage] = useState(() => peekCloudImage("boxd"));
	const cachedSnapshot = cachedImage?.snapshot;
	const initialized = useRef(
		!authenticationOnly && cachedSnapshot !== undefined,
	);
	const changed = useRef(onChanged);
	changed.current = onChanged;
	const [image, setImage] = useState<CloudAccountImage | null>(
		authenticationOnly ? null : (cachedImage ?? null),
	);
	const [snapshotId, setSnapshotId] = useState(
		cachedSnapshot?.snapshotId ?? "",
	);
	const [runtimeUser, setRuntimeUser] = useState(
		cachedSnapshot?.runtimeUser ?? "boxd",
	);
	const [paths, setPaths] = useState<readonly string[]>(
		() =>
			cachedSnapshot?.repositories.map((repository) => repository.path) ?? [],
	);
	const [agentAuthentication, setAgentAuthentication] = useState<
		"native" | "zuse"
	>(cachedSnapshot?.agentAuthentication ?? "native");
	const [gitAuthentication, setGitAuthentication] = useState<"native" | "zuse">(
		cachedSnapshot?.gitAuthentication ?? "native",
	);
	const [pathsOpen, setPathsOpen] = useState(false);

	const [applied, setApplied] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inspecting = image?.state === "building";
	const authenticationBusy = saving || (applied && inspecting);
	useEffect(() => {
		let disposed = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const load = async () => {
			try {
				const next = await loadCloudImage("boxd", true);
				if (disposed) return;
				setImage(next);
				if (!initialized.current && next.snapshot) {
					initialized.current = true;
					setSnapshotId(next.snapshot.snapshotId);
					setRuntimeUser(next.snapshot.runtimeUser);
					setPaths(
						next.snapshot.repositories.map((repository) => repository.path),
					);
					setAgentAuthentication(next.snapshot.agentAuthentication ?? "native");
					setGitAuthentication(next.snapshot.gitAuthentication ?? "native");
				}
				if (next.state === "building")
					timer = setTimeout(() => void load(), 3000);
				else if (inspecting) {
					await refreshCloudImages();
					if (!disposed) await changed.current();
				}
			} catch {
				if (!disposed) setError(uiMessage("settings:snapshot_refresh_error"));
			}
		};
		void load();
		return () => {
			disposed = true;
			if (timer) clearTimeout(timer);
		};
	}, [connectionId, inspecting, uiMessage]);
	const inspect = async () => {
		setSaving(true);
		setError(null);
		try {
			const next = await runCloudControl((client) =>
				client["cloud.snapshot.import"]({
					connectionId,
					gitAuthentication,
					agentAuthentication,
					snapshotId: snapshotId.trim(),
					runtimeUser: runtimeUser.trim(),
					repositoryPaths: paths.map((path) => path.trim()).filter(Boolean),
					idempotencyKey: crypto.randomUUID(),
				}),
			);
			setImage(next);
			await refreshCloudImages();
			await onChanged();
			setApplied(true);
		} catch {
			setError(uiMessage("settings:snapshot_inspect_error"));
		} finally {
			setSaving(false);
		}
	};
	const authChoices = [
		{
			key: "agents",
			value: agentAuthentication,
			onChange: setAgentAuthentication,
			label: uiMessage("settings:snapshot_agent_logins"),
			help: uiMessage("settings:snapshot_agent_logins_help"),
		},
		{
			key: "github",
			value: gitAuthentication,
			onChange: setGitAuthentication,
			label: uiMessage("settings:snapshot_github_login"),
			help: uiMessage("settings:snapshot_github_login_help"),
		},
	] as const;
	const status = error ?? snapshotErrorMessage(image?.errorCode, uiMessage);
	if (authenticationOnly)
		return (
			<CloudSnapshotAuthPanel
				image={image}
				agentAuthentication={agentAuthentication}
				busy={authenticationBusy}
				status={status}
				onSourceChange={(source) => {
					setApplied(false);
					setAgentAuthentication(source);
				}}
				onApply={inspect}
				applied={applied}
			/>
		);

	return (
		<div className="flex flex-col gap-2.5 px-3 py-2.5">
			<div className="flex flex-col gap-1.5">
				<p className="text-[11px] text-muted-foreground">
					{uiMessage("settings:snapshot_install_step")}
				</p>
				<DeviceCode
					code={SNAPSHOT_INSTALL_COMMAND}
					label={uiMessage("settings:snapshot_copy_command")}
				/>
			</div>
			<p className="text-[11px] text-muted-foreground">
				{uiMessage("settings:snapshot_connect_step")}
			</p>
			<div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
				<label htmlFor={`${fieldId}-snapshot`} className="text-xs">
					{uiMessage("settings:snapshot_id_label")}
				</label>
				<Input
					id={`${fieldId}-snapshot`}
					className="h-7 min-w-0 text-xs"
					spellCheck={false}
					placeholder={uiMessage("settings:snapshot_id_placeholder")}
					value={snapshotId}
					disabled={saving || inspecting}
					onChange={(event) => setSnapshotId(event.target.value)}
				/>
				<label htmlFor={`${fieldId}-user`} className="text-xs">
					{uiMessage("settings:snapshot_user_label")}
				</label>
				<Input
					id={`${fieldId}-user`}
					className="h-7 w-56 text-xs"
					spellCheck={false}
					value={runtimeUser}
					disabled={saving || inspecting}
					onChange={(event) => setRuntimeUser(event.target.value)}
				/>
				{authChoices.map((choice) => (
					<Fragment key={choice.key}>
						<span className="flex items-center gap-1 text-xs">
							{choice.label}
							<Tooltip>
								<TooltipTrigger
									className="flex size-5 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
									aria-label={choice.help}
								>
									<Info className="size-3" aria-hidden />
								</TooltipTrigger>
								<TooltipPopup className="max-w-64">{choice.help}</TooltipPopup>
							</Tooltip>
						</span>
						<select
							id={`${fieldId}-${choice.key}`}
							aria-label={choice.label}
							className="h-7 w-full rounded-md bg-muted/50 px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
							value={choice.value}
							disabled={saving || inspecting}
							onChange={(event) => {
								setApplied(false);
								choice.onChange(
									event.target.value === "native" ? "native" : "zuse",
								);
							}}
						>
							<option value="native">
								{uiMessage("settings:snapshot_source_snapshot")}
							</option>
							<option value="zuse">
								{uiMessage("settings:snapshot_source_zuse")}
							</option>
						</select>
					</Fragment>
				))}
			</div>
			{agentAuthentication === "zuse" ? (
				<>
					<p className="text-[11px] text-muted-foreground">
						{uiMessage("settings:snapshot_source_zuse_help")}
					</p>
					<CloudWorkspaceAuth providers={["claude", "codex"]} />
				</>
			) : null}
			{agentAuthentication === "native" ? (
				<p className="text-[11px] leading-4 text-muted-foreground">
					{uiMessage("settings:snapshot_native_source_help")}
				</p>
			) : null}
			<Collapsible open={pathsOpen} onOpenChange={setPathsOpen}>
				<CollapsibleTrigger className="flex h-7 items-center gap-1 rounded-md text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
					<ChevronRight
						className={cn(
							"size-3 transition-transform duration-150",
							pathsOpen && "rotate-90",
						)}
						aria-hidden
					/>
					{paths.length > 0
						? uiMessage("settings:snapshot_paths_count", {
								value: paths.length,
							})
						: uiMessage("settings:snapshot_paths_automatic")}
				</CollapsibleTrigger>
				<CollapsiblePanel>
					<div className="flex flex-col gap-2 pt-1">
						{paths.map((path, index) => (
							<div className="flex gap-2" key={index}>
								<Input
									className="h-7 text-xs"
									spellCheck={false}
									aria-label={uiMessage("settings:snapshot_repository_path", {
										number: index + 1,
									})}
									placeholder={uiMessage("settings:snapshot_path_example")}
									value={path}
									onChange={(event) =>
										setPaths(
											paths.map((value, position) =>
												position === index ? event.target.value : value,
											),
										)
									}
								/>
								<Button
									className={COMPACT_CLOUD_ACTION}
									variant="ghost"
									size="xs"
									onClick={() =>
										setPaths(paths.filter((_, position) => position !== index))
									}
								>
									{uiMessage("settings:snapshot_remove")}
								</Button>
							</div>
						))}
						<Button
							className={cn(COMPACT_CLOUD_ACTION, "w-fit")}
							size="xs"
							variant="ghost"
							disabled={paths.length >= 32}
							onClick={() => setPaths([...paths, ""])}
						>
							{uiMessage("settings:snapshot_add_path")}
						</Button>
					</div>
				</CollapsiblePanel>
			</Collapsible>
			<div className="flex items-center justify-between gap-3">
				<p
					role={status ? "alert" : "status"}
					className={cn(
						"min-w-0 text-[11px] leading-4",
						status ? "text-destructive" : "text-muted-foreground",
					)}
				>
					{status ??
						(inspecting
							? uiMessage("settings:snapshot_discovering")
							: image?.snapshot && image.state === "ready"
								? uiMessage("settings:snapshot_ready_summary")
								: null)}
				</p>
				<Button
					className={COMPACT_CLOUD_ACTION}
					size="xs"
					disabled={
						!snapshotId.trim() || !runtimeUser.trim() || inspecting || saving
					}
					loading={saving || inspecting}
					onClick={() => void inspect()}
				>
					{inspecting
						? uiMessage("settings:snapshot_inspecting")
						: uiMessage("common:save")}
				</Button>
			</div>
		</div>
	);
}

const snapshotErrorMessage = (
	code: string | undefined,
	uiMessage: ReturnType<typeof useUiMessages>["message"],
) => {
	switch (code) {
		case "snapshot-installer-required":
			return uiMessage("settings:snapshot_installer_required");
		case "snapshot-runtime-user-mismatch":
			return uiMessage("settings:snapshot_user_mismatch");
		case "snapshot-no-repositories-add-paths":
			return uiMessage("settings:snapshot_no_repositories");
		case "snapshot-repository-ambiguous":
			return uiMessage("settings:snapshot_ambiguous");
		case "snapshot-runtime-update-required":
			return uiMessage("settings:snapshot_update_required");
		case "snapshot-repository-not-writable":
		case "snapshot-repository-invalid":
			return uiMessage("settings:snapshot_invalid_repository");
		case "snapshot-inspection-timeout":
			return uiMessage("settings:snapshot_timeout");
		default:
			return code
				? uiMessage("settings:snapshot_unknown_error", { code })
				: null;
	}
};
