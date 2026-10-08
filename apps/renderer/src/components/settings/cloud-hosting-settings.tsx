import "@zuse/i18n/english/settings";
import type {
	CloudAccountImage,
	CloudProviderConnection,
} from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "~/lib/utils";
import { cloudProviderLabel } from "../../lib/cloud-provider-presentation.ts";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import {
	CloudProviderConnectForm,
	CloudProviderDisconnectDialog,
	CloudProviderKeyPanel,
	useCloudProviderConnections,
} from "./cloud-provider-keys.tsx";
import {
	CloudSettingsGroup,
	CloudSettingsRow,
	COMPACT_CLOUD_ACTION,
} from "./cloud-settings-ui.tsx";
import { CloudSnapshotSettings } from "./cloud-snapshot-settings.tsx";

/** Where new cloud workspaces run, and who bills for the machines. */
export type CloudHostingMode = "zuse" | "provider" | "snapshot";

export function CloudHostingSettings({
	paidSubscription,
	loading,
	canManageBilling,
	canManageProviders,
	activeMode,
	selectedProviderId,
	snapshot,
	busy,
	onCheckout,
	onManage,
	onChanged,
}: {
	readonly paidSubscription: boolean | null;
	readonly loading: boolean;
	readonly canManageBilling: boolean;
	readonly canManageProviders: boolean;
	readonly activeMode: CloudHostingMode | null;
	/** Provider new workspaces use; its connected key overrides Zuse hosting. */
	readonly selectedProviderId: string | null;
	readonly snapshot: CloudAccountImage | null;
	readonly busy: string | null;
	readonly onCheckout: () => void;
	readonly onManage: () => void;
	readonly onChanged: () => Promise<void>;
}) {
	const { message } = useMessages(["common", "settings"]);
	const keys = useCloudProviderConnections();
	const [open, setOpen] = useState<CloudHostingMode | null>(null);
	const toggle = (mode: CloudHostingMode) =>
		setOpen((current) => (current === mode ? null : mode));
	const boxdKey = keys.active.find(
		(connection) => connection.providerId === "boxd",
	);
	const connectedProviders = [
		...new Set(
			keys.active.map((connection) =>
				cloudProviderLabel(connection.providerId),
			),
		),
	].join(", ");
	const inUse = (mode: CloudHostingMode) =>
		activeMode === mode ? (
			<Badge variant="success">
				{message("settings:cloud_hosting_in_use")}
			</Badge>
		) : null;
	const snapshotConfig = snapshot?.snapshot;
	// A connected key replaces Zuse hosting for that provider until disconnected.
	const overridingKey = keys.active.find(
		(connection) => connection.providerId === selectedProviderId,
	);
	const [switchTarget, setSwitchTarget] =
		useState<CloudProviderConnection | null>(null);

	return (
		<CloudSettingsGroup
			title={message("settings:cloud_hosting_title")}
			help={message("settings:cloud_hosting_accounts_description")}
		>
			<CloudSettingsRow
				title={message("settings:cloud_hosting_zuse")}
				description={
					paidSubscription === true && overridingKey !== undefined
						? message("settings:cloud_hosting_zuse_overridden", {
								provider: cloudProviderLabel(overridingKey.providerId),
							})
						: paidSubscription === true
							? message("settings:cloud_hosting_zuse_subscribed_description")
							: message("settings:cloud_hosting_zuse_description")
				}
				action={
					<>
						{inUse("zuse")}
						{paidSubscription === true &&
						overridingKey !== undefined &&
						canManageProviders ? (
							<Button
								size="xs"
								variant="ghost"
								className={COMPACT_CLOUD_ACTION}
								onClick={() => setSwitchTarget(overridingKey)}
							>
								{message("settings:cloud_hosting_switch_to_zuse")}
							</Button>
						) : null}
						{paidSubscription === null ? (
							<Badge variant="outline">
								{loading
									? message("common:loading")
									: message(
											"settings:cloud_workspace_pool_could_not_load_billing",
										)}
							</Badge>
						) : !canManageBilling ? (
							<Badge variant={paidSubscription ? "success" : "outline"}>
								{paidSubscription
									? message("settings:cloud_hosting_subscribed")
									: message("settings:cloud_hosting_not_subscribed")}
							</Badge>
						) : (
							<Button
								size="xs"
								variant={
									paidSubscription || activeMode !== null ? "ghost" : "default"
								}
								className={COMPACT_CLOUD_ACTION}
								disabled={busy !== null}
								loading={
									busy === (paidSubscription ? "billing-portal" : "checkout")
								}
								onClick={paidSubscription ? onManage : onCheckout}
							>
								{paidSubscription
									? message("settings:cloud_hosting_manage_subscription")
									: message("settings:cloud_workspace_pool_subscribe_40_month")}
							</Button>
						)}
					</>
				}
			/>
			<HostingOption
				title={message("settings:cloud_hosting_own_key")}
				description={
					keys.active.length > 0
						? message("settings:cloud_hosting_own_key_connected", {
								providers: connectedProviders,
							})
						: message("settings:cloud_hosting_own_key_description")
				}
				status={overridingKey === undefined ? null : inUse("provider")}
				actionLabel={
					keys.active.length > 0
						? message("settings:cloud_hosting_manage")
						: message("settings:cloud_provider_keys_connect")
				}
				open={open === "provider"}
				onToggle={() => toggle("provider")}
				disabled={!canManageProviders}
			>
				<CloudProviderKeyPanel keys={keys} onChanged={onChanged} />
			</HostingOption>
			{keys.customSnapshotsEnabled ? (
				<HostingOption
					title={message("settings:cloud_hosting_own_snapshot")}
					description={
						snapshotConfig !== undefined
							? message("settings:cloud_hosting_own_snapshot_configured", {
									snapshot: snapshotConfig.snapshotId,
								})
							: message("settings:cloud_hosting_own_snapshot_description")
					}
					status={
						activeMode === "snapshot" ? (
							inUse("snapshot")
						) : snapshot?.state === "building" ? (
							<Badge variant="warning">
								{message("settings:snapshot_checking")}
							</Badge>
						) : snapshot !== null && snapshot.state !== "ready" ? (
							<Badge variant="warning">
								{message("settings:snapshot_attention")}
							</Badge>
						) : null
					}
					actionLabel={
						snapshotConfig !== undefined
							? message("settings:cloud_hosting_edit")
							: message("settings:cloud_hosting_set_up")
					}
					open={open === "snapshot"}
					onToggle={() => toggle("snapshot")}
					disabled={!canManageProviders}
				>
					{boxdKey !== undefined ? (
						<CloudSnapshotSettings
							connectionId={boxdKey.connectionId}
							onChanged={onChanged}
						/>
					) : (
						<div className="flex flex-col gap-2 px-3 py-2.5">
							<p className="text-[11px] text-muted-foreground">
								{message("settings:cloud_hosting_snapshot_needs_boxd")}
							</p>
							<CloudProviderConnectForm
								keys={keys}
								providerId="boxd"
								onChanged={onChanged}
							/>
						</div>
					)}
				</HostingOption>
			) : null}
			<CloudProviderDisconnectDialog
				keys={keys}
				target={switchTarget}
				switchToZuse
				onClose={() => setSwitchTarget(null)}
				onChanged={onChanged}
			/>
		</CloudSettingsGroup>
	);
}

/** A hosting choice whose setup expands in place instead of in another section. */
function HostingOption({
	title,
	description,
	status,
	actionLabel,
	open,
	onToggle,
	disabled,
	children,
}: {
	readonly title: string;
	readonly description: string;
	readonly status: ReactNode;
	readonly actionLabel: string;
	readonly open: boolean;
	readonly onToggle: () => void;
	readonly disabled: boolean;
	readonly children: ReactNode;
}) {
	return (
		<>
			<CloudSettingsRow
				title={title}
				description={description}
				action={
					<>
						{status}
						{disabled ? null : (
							<Button
								size="xs"
								variant="ghost"
								className={COMPACT_CLOUD_ACTION}
								aria-expanded={open}
								onClick={onToggle}
							>
								{actionLabel}
								<ChevronRight
									className={cn(
										"size-3 transition-transform duration-150",
										open && "rotate-90",
									)}
									aria-hidden
								/>
							</Button>
						)}
					</>
				}
			/>
			{open && !disabled ? (
				<div className="flex flex-col divide-y divide-border bg-muted/25">
					{children}
				</div>
			) : null}
		</>
	);
}
