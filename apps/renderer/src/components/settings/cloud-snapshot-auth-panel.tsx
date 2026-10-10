import "@zuse/i18n/english/common";
import "@zuse/i18n/english/settings";
import type { CloudAccountImage } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { Check } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/button.tsx";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "../ui/select.tsx";
import { SettingsNote } from "../ui/settings-panel.tsx";
import {
	CloudSettingsGroup,
	CloudSettingsRow,
	COMPACT_CLOUD_ACTION,
} from "./cloud-settings-ui.tsx";
import { CloudSnapshotAgentRows } from "./cloud-snapshot-access.tsx";
import { CloudWorkspaceAuth } from "./cloud-workspace-auth.tsx";

type AgentAuthentication = "native" | "zuse";

/** Snapshot logins are the default; another source applies only after confirmation. */
export function CloudSnapshotAuthPanel({
	image,
	agentAuthentication,
	busy,
	status,
	applied,
	onSourceChange,
	onApply,
}: {
	readonly image: CloudAccountImage | null;
	readonly agentAuthentication: AgentAuthentication;
	readonly busy: boolean;
	readonly status: string | null;
	readonly applied: boolean;
	readonly onSourceChange: (source: AgentAuthentication) => void;
	readonly onApply: () => Promise<void>;
}) {
	const { message } = useMessages(["common", "settings"]);
	const [connectedCount, setConnectedCount] = useState<number | null>(null);
	const savedSource = image?.snapshot?.agentAuthentication ?? "native";
	const pending = savedSource !== agentAuthentication;
	const native = agentAuthentication === "native";
	const ready = image?.snapshot !== undefined && image.state !== "building";
	const canApply = native || (connectedCount ?? 0) > 0;
	const sourceLabel = (source: AgentAuthentication) =>
		message(
			source === "native"
				? "settings:snapshot_native_option"
				: "settings:snapshot_zuse_option",
		);
	const changeSource = (source: AgentAuthentication) => {
		setConnectedCount(null);
		onSourceChange(source);
	};
	return (
		<CloudSettingsGroup
			title={message("settings:snapshot_sign_in_title")}
			footer={message(
				native
					? "settings:snapshot_native_footer"
					: "settings:snapshot_zuse_footer",
			)}
		>
			<CloudSettingsRow
				title={message("settings:snapshot_sign_in_with")}
				description={message(
					native
						? "settings:snapshot_primary_help"
						: "settings:snapshot_zuse_option_help",
				)}
				action={
					<Select
						value={agentAuthentication}
						disabled={busy || !ready}
						onValueChange={(value) =>
							changeSource(value === "zuse" ? "zuse" : "native")
						}
					>
						<SelectTrigger
							size="sm"
							className="h-7 w-36"
							aria-label={message("settings:snapshot_sign_in_with")}
						>
							<SelectValue>
								{(value: AgentAuthentication) => sourceLabel(value)}
							</SelectValue>
						</SelectTrigger>
						<SelectPopup>
							<SelectItem value="native">{sourceLabel("native")}</SelectItem>
							<SelectItem value="zuse">{sourceLabel("zuse")}</SelectItem>
						</SelectPopup>
					</Select>
				}
			/>
			{native ? (
				image === null ? (
					<SettingsNote>
						{message("settings:cloud_workspace_auth_checking")}
					</SettingsNote>
				) : (
					<CloudSnapshotAgentRows image={image} />
				)
			) : (
				<CloudWorkspaceAuth
					providers={["claude", "codex"]}
					embedded
					onConnectedCountChange={setConnectedCount}
				/>
			)}
			{pending ? (
				<CloudSettingsRow
					className="bg-muted/40"
					title={message(
						native
							? "settings:snapshot_switch_to_native"
							: "settings:snapshot_switch_to_zuse",
					)}
					description={
						canApply
							? message("settings:snapshot_switch_scope")
							: message("settings:snapshot_connect_to_switch")
					}
					action={
						<>
							<Button
								className={COMPACT_CLOUD_ACTION}
								size="xs"
								variant="ghost"
								disabled={busy}
								onClick={() => changeSource(savedSource)}
							>
								{message("common:cancel")}
							</Button>
							<Button
								className={COMPACT_CLOUD_ACTION}
								size="xs"
								disabled={busy || !ready || !canApply}
								loading={busy}
								onClick={() => void onApply()}
							>
								{message("settings:snapshot_apply_auth")}
							</Button>
						</>
					}
				/>
			) : null}
			{status ? (
				<SettingsNote tone="error">{status}</SettingsNote>
			) : busy && !pending ? (
				<SettingsNote>
					{message("settings:snapshot_auth_applying")}
				</SettingsNote>
			) : applied && image?.state === "ready" ? (
				<SettingsNote>
					<Check className="size-3 text-success" aria-hidden />
					{message("settings:snapshot_auth_saved")}
				</SettingsNote>
			) : null}
		</CloudSettingsGroup>
	);
}
