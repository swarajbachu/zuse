import type { CloudAccountImage } from "@zuse/contracts";
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
				if (!disposed)
					setError(
						"Could not refresh snapshot status. Reopen settings to retry.",
					);
			}
		};
		void load();
		return () => {
			disposed = true;
			if (timer) clearTimeout(timer);
		};
	}, [connectionId, inspecting]);
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
			setError(
				"Could not inspect the snapshot. Check its ID, Linux user, and Boxd key permissions.",
			);
		} finally {
			setSaving(false);
		}
	};
	return (
		<CloudSettingsRow
			title="Custom Boxd snapshot"
			description="Install Zuse, create a snapshot, then discover its repositories. Inspection briefly starts a machine on your Boxd account."
		>
			<div className="flex flex-col gap-2">
				<a
					className="text-xs underline"
					href="https://github.com/swarajbachu/zuse/releases/download/cloud-runtime-production/zuse-snapshot-installer.tar.gz"
					target="_blank"
					rel="noreferrer"
				>
					Download snapshot installer
				</a>
				<p className="text-xs text-muted-foreground">
					Run the installer on your machine. It does not need repository paths
					or GitHub credentials.
				</p>
				<Input
					className="h-7"
					aria-label="Boxd snapshot ID"
					placeholder={image?.snapshot?.snapshotId ?? "Snapshot ID"}
					value={snapshotId}
					onChange={(event) => setSnapshotId(event.target.value)}
				/>
				<Input
					className="h-7"
					aria-label="Snapshot Linux user"
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
					Use my Zuse agent accounts for new workspaces
				</label>
				<label className="flex items-center gap-2 text-xs">
					<input
						type="checkbox"
						checked={gitAuthentication === "zuse"}
						onChange={(event) =>
							setGitAuthentication(event.target.checked ? "zuse" : "native")
						}
					/>
					Use my Zuse GitHub connection for Git and gh
				</label>
				<p className="text-xs text-muted-foreground">
					Use the Linux username printed by the installer. Leave paths empty to
					find repositories automatically.
				</p>
				{paths.map((path, index) => (
					<div className="flex gap-2" key={index}>
						<Input
							className="h-7"
							aria-label={`Repository path ${index + 1}`}
							placeholder="/home/boxd/my-repository"
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
							Remove
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
						Add repository path
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
						{inspecting ? "Inspecting snapshot…" : "Use snapshot"}
					</Button>
				</div>
				{image?.snapshot?.repositories.map((repository) => (
					<div className="text-xs" key={repository.projectId}>
						<p>{repository.path}</p>
						<p className="text-muted-foreground">
							{repository.gitAccess === "readable"
								? "Git read access detected"
								: repository.gitAccess === "authentication-required"
									? "Git login needed — connect GitHub in Cloud settings"
									: "Git access could not be verified; check the connection"}
						</p>
					</div>
				))}
				{image?.snapshot ? (
					<p className="text-xs text-muted-foreground">
						{image.snapshot.agentAuthentication === "zuse"
							? "New workspaces use your connected Zuse agent accounts."
							: "Existing Claude Code and Codex logins will be checked when you open a workspace. A detected login is not a guarantee of access; expired credentials require signing in again."}
					</p>
				) : null}
				{error || image?.errorCode ? (
					<p className="text-xs text-destructive" role="alert">
						{error ?? snapshotErrorMessage(image?.errorCode)}
					</p>
				) : null}
			</div>
		</CloudSettingsRow>
	);
}

const snapshotErrorMessage = (code: string | undefined) => {
	switch (code) {
		case "snapshot-installer-required":
			return "Install Zuse on the source machine, create a new snapshot, then retry with its ID.";
		case "snapshot-runtime-user-mismatch":
			return "Enter the Linux user printed by the installer.";
		case "snapshot-no-repositories-add-paths":
			return "No GitHub repositories found. Add their absolute paths and inspect again.";
		case "snapshot-repository-ambiguous":
			return "Multiple checkouts have the same GitHub origin. Add an explicit path to choose one.";
		case "snapshot-runtime-update-required":
			return "Rerun the latest installer and create a new snapshot.";
		case "snapshot-repository-invalid":
			return "A repository path must point to the writable root of a Git checkout.";
		case "snapshot-inspection-timeout":
			return "Snapshot inspection timed out. Check the snapshot and retry.";
		default:
			return code
				? `Snapshot could not be used (${code}). Check the installer, paths and Boxd permissions, then retry.`
				: null;
	}
};
