import "@zuse/i18n/english/settings";
import type { CloudAccountImage } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { useEffect, useRef, useState } from "react";
import { refreshCloudImages } from "../../lib/cloud-image-monitor.ts";
import { loadCloudImage } from "../../lib/cloud-workspace-session-cache.ts";
import { runCloudControl } from "../../lib/control-plane-client.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { CloudSettingsRow } from "./cloud-settings-ui.tsx";

export function CloudSnapshotSettings({
	connectionId,
	onChanged,
}: {
	readonly connectionId: string;
	readonly onChanged: () => Promise<void>;
}) {
	const { message: uiMessage } = useUiMessages(["settings"]);
	const initialized = useRef(false);
	const changed = useRef(onChanged);
	changed.current = onChanged;
	const [image, setImage] = useState<CloudAccountImage | null>(null);
	const [snapshotId, setSnapshotId] = useState("");
	const [runtimeUser, setRuntimeUser] = useState("boxd");
	const [paths, setPaths] = useState<readonly string[]>([]);
	const [agentAuthentication, setAgentAuthentication] = useState<
		"native" | "zuse"
	>("native");
	const [gitAuthentication, setGitAuthentication] = useState<"native" | "zuse">(
		"native",
	);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inspecting = image?.state === "building";
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
		} catch {
			setError(uiMessage("settings:snapshot_inspect_error"));
		} finally {
			setSaving(false);
		}
	};
	return (
		<CloudSettingsRow
			title={uiMessage("settings:snapshot_title")}
			description={uiMessage("settings:snapshot_description")}
		>
			<div className="flex flex-col gap-2">
				<a
					className="text-xs underline"
					href="https://github.com/swarajbachu/zuse/releases/download/cloud-runtime-production/zuse-snapshot-installer.tar.gz"
					target="_blank"
					rel="noreferrer"
				>
					{uiMessage("settings:snapshot_download")}
				</a>
				<p className="text-xs text-muted-foreground">
					{uiMessage("settings:snapshot_install_command", {
						command: "npx zusehq snapshot install",
					})}
				</p>
				<Input
					className="h-7"
					aria-label={uiMessage("settings:snapshot_id_label")}
					placeholder={
						image?.snapshot?.snapshotId ??
						uiMessage("settings:snapshot_id_placeholder")
					}
					value={snapshotId}
					onChange={(event) => setSnapshotId(event.target.value)}
				/>
				<Input
					className="h-7"
					aria-label={uiMessage("settings:snapshot_user_label")}
					value={runtimeUser}
					onChange={(event) => setRuntimeUser(event.target.value)}
				/>
				<label className="flex items-center gap-2 text-xs">
					<input
						type="checkbox"
						checked={agentAuthentication === "zuse"}
						onChange={(event) =>
							setAgentAuthentication(event.target.checked ? "zuse" : "native")
						}
					/>
					{uiMessage("settings:snapshot_agent_accounts")}
				</label>
				<label className="flex items-center gap-2 text-xs">
					<input
						type="checkbox"
						checked={gitAuthentication === "zuse"}
						onChange={(event) =>
							setGitAuthentication(event.target.checked ? "zuse" : "native")
						}
					/>
					{uiMessage("settings:snapshot_github_connection")}
				</label>
				<p className="text-xs text-muted-foreground">
					{uiMessage("settings:snapshot_discovery_hint")}
				</p>
				{paths.map((path, index) => (
					<div className="flex gap-2" key={index}>
						<Input
							className="h-7"
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
							className="h-7"
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
				<div className="flex gap-2">
					<Button
						className="h-7"
						size="xs"
						variant="ghost"
						disabled={paths.length >= 32}
						onClick={() => setPaths([...paths, ""])}
					>
						{uiMessage("settings:snapshot_add_path")}
					</Button>
					<Button
						className="h-7"
						size="xs"
						disabled={
							!snapshotId.trim() || !runtimeUser.trim() || inspecting || saving
						}
						loading={saving}
						onClick={() => void inspect()}
					>
						{inspecting
							? uiMessage("settings:snapshot_inspecting")
							: uiMessage("settings:snapshot_use")}
					</Button>
				</div>
				{image?.snapshot?.repositories.map((repository) => (
					<div className="text-xs" key={repository.projectId}>
						<p>{repository.path}</p>
						<p className="text-muted-foreground">
							{repository.gitAccess === "readable"
								? uiMessage("settings:snapshot_git_readable")
								: repository.gitAccess === "authentication-required"
									? uiMessage("settings:snapshot_git_login")
									: uiMessage("settings:snapshot_git_unavailable")}
						</p>
					</div>
				))}
				{image?.snapshot ? (
					<p className="text-xs text-muted-foreground">
						{image.snapshot.agentAuthentication === "zuse"
							? uiMessage("settings:snapshot_managed_agents")
							: uiMessage("settings:snapshot_native_agents")}
					</p>
				) : null}
				{error || image?.errorCode ? (
					<p className="text-xs text-destructive" role="alert">
						{error ?? snapshotErrorMessage(image?.errorCode, uiMessage)}
					</p>
				) : null}
			</div>
		</CloudSettingsRow>
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
