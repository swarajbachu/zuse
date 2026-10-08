import {
	cacheCloudProviderConnections,
	loadCloudProviderConnections,
	peekCloudProviderConnections,
} from "../../lib/cloud-workspace-session-cache.ts";
import "@zuse/i18n/english/settings";
import type {
	CloudProviderConnection,
	CloudProviderConnectionInput,
	CloudProviderConnectionList,
} from "@zuse/contracts";
import { formatDate } from "@zuse/i18n";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Check, ChevronRight, KeyRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "~/lib/utils";
import { cloudProviderLabel } from "../../lib/cloud-provider-presentation.ts";
import {
	runCloudControl,
	subscribeControlPlaneSessionCache,
} from "../../lib/control-plane-client.ts";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "../ui/alert-dialog.tsx";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "../ui/collapsible.tsx";
import { Input } from "../ui/input.tsx";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "../ui/select.tsx";
import {
	CloudSettingsRow,
	COMPACT_CLOUD_ACTION,
} from "./cloud-settings-ui.tsx";

type ProviderId = CloudProviderConnectionInput["providerId"];

/** boxd first, matching the recommended order used by image providers. */
const PROVIDER_IDS: readonly ProviderId[] = ["boxd", "e2b", "box"];

const isProviderId = (value: unknown): value is ProviderId =>
	PROVIDER_IDS.some((providerId) => providerId === value);

export function CloudProviderKeyList({
	connections,
	loading,
	loadError,
	busy,
	onRetry,
	onDisconnect,
}: {
	readonly connections: readonly CloudProviderConnection[] | null;
	readonly loading: boolean;
	readonly loadError: boolean;
	readonly busy: string | null;
	readonly onRetry: () => void;
	readonly onDisconnect: (connection: CloudProviderConnection) => void;
}) {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);
	if (loadError) {
		return (
			<div className="flex items-center justify-between gap-3 px-3 py-2">
				<p role="alert" className="text-xs text-destructive">
					{uiMessage("settings:cloud_provider_keys_load_failed")}
				</p>
				<Button
					size="xs"
					variant="ghost"
					className={COMPACT_CLOUD_ACTION}
					loading={loading}
					onClick={onRetry}
				>
					{uiMessage("common:retry")}
				</Button>
			</div>
		);
	}
	if (connections === null) {
		return (
			<CloudSettingsRow
				title={uiMessage("settings:cloud_provider_keys_loading")}
			/>
		);
	}
	const active = connections.filter((connection) => connection.active);
	if (active.length === 0) {
		return (
			<CloudSettingsRow
				title={uiMessage("settings:cloud_provider_keys_empty_title")}
				description={uiMessage(
					"settings:cloud_provider_keys_empty_description",
				)}
				action={
					<KeyRound className="size-4 text-muted-foreground" aria-hidden />
				}
			/>
		);
	}
	return active.map((connection) => {
		const provider = cloudProviderLabel(connection.providerId);
		const details = [
			uiMessage("settings:cloud_hosting_provider_billed"),
			uiMessage("settings:cloud_provider_keys_connected_on", {
				date: formatDate(connection.createdAt, {
					month: "short",
					day: "numeric",
					year: "numeric",
				}),
			}),
			connection.templateId === undefined
				? null
				: uiMessage("settings:cloud_provider_keys_template_detail", {
						template: connection.templateId,
					}),
			connection.organization === undefined
				? null
				: uiMessage("settings:cloud_provider_keys_organization_detail", {
						organization: connection.organization,
					}),
		].filter((detail) => detail !== null);
		return (
			<CloudSettingsRow
				key={connection.connectionId}
				title={provider}
				description={details.join(" · ")}
				action={
					<>
						<Badge variant="success">
							<Check aria-hidden />
							{uiMessage("settings:cloud_provider_keys_connected")}
						</Badge>
						<Button
							size="xs"
							variant="ghost"
							className={COMPACT_CLOUD_ACTION}
							aria-label={uiMessage(
								"settings:cloud_provider_keys_disconnect_label",
								{ provider },
							)}
							disabled={busy !== null}
							onClick={() => onDisconnect(connection)}
						>
							{uiMessage("settings:cloud_provider_keys_disconnect")}
						</Button>
					</>
				}
			/>
		);
	});
}

export type CloudProviderConnections = ReturnType<
	typeof useCloudProviderConnections
>;

/** Single source for the account's provider keys and custom-snapshot capability. */
export function useCloudProviderConnections() {
	const [connections, setConnections] = useState<
		readonly CloudProviderConnection[] | null
	>(() => peekCloudProviderConnections()?.connections ?? null);
	const [customSnapshotsEnabled, setCustomSnapshotsEnabled] = useState(
		() => peekCloudProviderConnections()?.customSnapshotsEnabled === true,
	);
	const [loading, setLoading] = useState(
		() => peekCloudProviderConnections() === undefined,
	);
	const [loadError, setLoadError] = useState(false);
	const mounted = useRef(true);
	const reloadVersion = useRef(0);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			reloadVersion.current += 1;
		};
	}, []);

	const accept = useCallback((result: CloudProviderConnectionList) => {
		if (!mounted.current) return;
		reloadVersion.current += 1;
		setLoading(false);
		setConnections(result.connections);
		setCustomSnapshotsEnabled(result.customSnapshotsEnabled === true);
		setLoadError(false);
	}, []);

	const apply = useCallback(
		(result: CloudProviderConnectionList) => {
			accept(result);
			void cacheCloudProviderConnections(result).catch(() => undefined);
		},
		[accept],
	);
	const reload = useCallback(async () => {
		const version = ++reloadVersion.current;
		setLoading(peekCloudProviderConnections() === undefined);
		try {
			const result = await loadCloudProviderConnections(true);
			if (version === reloadVersion.current) accept(result);
		} catch {
			if (mounted.current && version === reloadVersion.current)
				setLoadError(true);
		} finally {
			if (mounted.current && version === reloadVersion.current)
				setLoading(false);
		}
	}, [accept]);

	useEffect(() => {
		void reload();
		const onFocus = () => void reload();
		window.addEventListener("focus", onFocus);
		const unsubscribe = subscribeControlPlaneSessionCache((key) => {
			if (key !== "cloud-workspace:connections") return;
			const cached = peekCloudProviderConnections();
			if (cached) accept(cached);
		});
		return () => {
			window.removeEventListener("focus", onFocus);
			unsubscribe();
		};
	}, [reload, accept]);

	return {
		connections,
		active: (connections ?? []).filter((connection) => connection.active),
		customSnapshotsEnabled,
		loading,
		loadError,
		reload,
		apply,
	};
}

/** Provider key form; `providerId` pins the provider when a flow needs one. */
export function CloudProviderConnectForm({
	keys,
	providerId: pinnedProvider,
	onChanged,
}: {
	readonly keys: CloudProviderConnections;
	readonly providerId?: ProviderId;
	readonly onChanged: () => Promise<void>;
}) {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);
	const [selectedProvider, setSelectedProvider] = useState<ProviderId>("boxd");
	const providerId = pinnedProvider ?? selectedProvider;
	const [apiKey, setApiKey] = useState("");
	const [templateId, setTemplateId] = useState("");
	const [organization, setOrganization] = useState("");
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const replacing = keys.active.some(
		(connection) => connection.providerId === providerId,
	);
	const providerName = cloudProviderLabel(providerId);

	const selectProvider = (value: ProviderId) => {
		setSelectedProvider(value);
		setApiKey("");
		setTemplateId("");
		setOrganization("");
		setError(null);
	};

	const save = async () => {
		if (saving) return;
		setSaving(true);
		setError(null);
		try {
			keys.apply(
				await runCloudControl((client) =>
					client["cloud.providerConnections.save"]({
						providerId,
						apiKey: apiKey.trim(),
						templateId: templateId.trim() || undefined,
						organization:
							providerId === "boxd"
								? organization.trim() || undefined
								: undefined,
					}),
				),
			);
			setApiKey("");
			setTemplateId("");
			setOrganization("");
			setAdvancedOpen(false);
			await onChanged();
		} catch {
			setError(
				uiMessage("settings:cloud_provider_keys_save_failed", {
					provider: providerName,
				}),
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<form
			className="flex flex-col gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				if (apiKey.trim().length > 0) void save();
			}}
		>
			<div className="flex items-center gap-2">
				{pinnedProvider === undefined ? (
					<Select
						value={providerId}
						disabled={saving}
						onValueChange={(value) => {
							if (isProviderId(value)) selectProvider(value);
						}}
					>
						<SelectTrigger
							className="h-7 w-28 min-w-0"
							aria-label={uiMessage("settings:cloud_provider_keys_provider")}
						>
							<SelectValue>{providerName}</SelectValue>
						</SelectTrigger>
						<SelectPopup>
							{PROVIDER_IDS.map((id) => (
								<SelectItem key={id} value={id}>
									{cloudProviderLabel(id)}
								</SelectItem>
							))}
						</SelectPopup>
					</Select>
				) : null}
				<Input
					aria-label={uiMessage("settings:cloud_provider_keys_api_key", {
						provider: providerName,
					})}
					type="password"
					autoComplete="off"
					spellCheck={false}
					placeholder={uiMessage("settings:cloud_provider_keys_api_key", {
						provider: providerName,
					})}
					className="h-7 min-w-0 flex-1 text-xs"
					value={apiKey}
					disabled={saving}
					aria-invalid={error !== null && !saving ? true : undefined}
					onChange={(event) => {
						setApiKey(event.target.value);
						setError(null);
					}}
				/>
				<Button
					type="submit"
					size="xs"
					className={COMPACT_CLOUD_ACTION}
					disabled={saving || keys.connections === null || !apiKey.trim()}
					loading={saving}
				>
					{replacing
						? uiMessage("settings:cloud_provider_keys_replace")
						: uiMessage("settings:cloud_provider_keys_connect")}
				</Button>
			</div>
			{error === null ? null : (
				<p role="alert" className="text-[11px] text-destructive">
					{error}
				</p>
			)}
			<p className="text-[11px] leading-4 text-muted-foreground">
				{replacing
					? uiMessage("settings:cloud_provider_keys_replace_description")
					: uiMessage("settings:cloud_provider_keys_footer")}
			</p>
			<Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
				<CollapsibleTrigger className="flex h-7 items-center gap-1 rounded-md text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
					<ChevronRight
						className={cn(
							"size-3 transition-transform duration-150",
							advancedOpen && "rotate-90",
						)}
						aria-hidden
					/>
					{uiMessage("settings:cloud_provider_keys_advanced")}
				</CollapsibleTrigger>
				<CollapsiblePanel>
					<div className="flex flex-col gap-2 pt-1">
						<div className="flex items-center gap-2">
							<Input
								aria-label={uiMessage("settings:cloud_provider_keys_template")}
								placeholder={uiMessage("settings:cloud_provider_keys_template")}
								className="h-7 min-w-0 flex-1 text-xs"
								spellCheck={false}
								value={templateId}
								disabled={saving}
								onChange={(event) => setTemplateId(event.target.value)}
							/>
							{providerId === "boxd" ? (
								<Input
									aria-label={uiMessage(
										"settings:cloud_provider_keys_organization",
									)}
									placeholder={uiMessage(
										"settings:cloud_provider_keys_organization",
									)}
									className="h-7 min-w-0 flex-1 text-xs"
									spellCheck={false}
									value={organization}
									disabled={saving}
									onChange={(event) => setOrganization(event.target.value)}
								/>
							) : null}
						</div>
						<p className="text-[11px] leading-4 text-muted-foreground">
							{uiMessage("settings:cloud_provider_keys_template_hint", {
								provider: providerName,
							})}
						</p>
					</div>
				</CollapsiblePanel>
			</Collapsible>
		</form>
	);
}

/** Confirms disconnecting a provider key; `switchToZuse` explains the fallback. */
export function CloudProviderDisconnectDialog({
	keys,
	target,
	switchToZuse = false,
	onClose,
	onChanged,
}: {
	readonly keys: CloudProviderConnections;
	readonly target: CloudProviderConnection | null;
	readonly switchToZuse?: boolean;
	readonly onClose: () => void;
	readonly onChanged: () => Promise<void>;
}) {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const provider = target === null ? "" : cloudProviderLabel(target.providerId);

	const disconnect = async (connection: CloudProviderConnection) => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			keys.apply(
				await runCloudControl((client) =>
					client["cloud.providerConnections.disconnect"]({
						connectionId: connection.connectionId,
					}),
				),
			);
			onClose();
			await onChanged();
		} catch {
			setError(uiMessage("settings:cloud_provider_keys_disconnect_failed"));
		} finally {
			setBusy(false);
		}
	};

	return (
		<AlertDialog
			open={target !== null}
			onOpenChange={(open) => {
				if (!open && !busy) {
					setError(null);
					onClose();
				}
			}}
		>
			<AlertDialogPopup className="max-w-sm">
				<AlertDialogHeader>
					<AlertDialogTitle>
						{switchToZuse
							? uiMessage("settings:cloud_hosting_switch_to_zuse_title")
							: uiMessage("settings:cloud_provider_keys_disconnect_title", {
									provider,
								})}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{switchToZuse
							? uiMessage("settings:cloud_hosting_switch_to_zuse_description", {
									provider,
								})
							: uiMessage(
									"settings:cloud_provider_keys_disconnect_description",
									{ provider },
								)}
					</AlertDialogDescription>
					{error === null ? null : (
						<p role="alert" className="text-xs text-destructive">
							{error}
						</p>
					)}
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogClose
						render={
							<Button
								size="xs"
								variant="ghost"
								className={COMPACT_CLOUD_ACTION}
							/>
						}
					>
						{uiMessage("common:cancel")}
					</AlertDialogClose>
					<Button
						size="xs"
						variant={switchToZuse ? "default" : "destructive"}
						className={COMPACT_CLOUD_ACTION}
						loading={busy}
						onClick={() => {
							if (target !== null) void disconnect(target);
						}}
					>
						{switchToZuse
							? uiMessage("settings:cloud_hosting_switch_to_zuse")
							: uiMessage("settings:cloud_provider_keys_disconnect")}
					</Button>
				</AlertDialogFooter>
			</AlertDialogPopup>
		</AlertDialog>
	);
}

/** Connected keys, the connect form and disconnect confirmation. */
export function CloudProviderKeyPanel({
	keys,
	onChanged,
}: {
	readonly keys: CloudProviderConnections;
	readonly onChanged: () => Promise<void>;
}) {
	const [disconnectTarget, setDisconnectTarget] =
		useState<CloudProviderConnection | null>(null);
	return (
		<>
			{keys.active.length > 0 || keys.loadError || keys.connections === null ? (
				<CloudProviderKeyList
					connections={keys.connections}
					loading={keys.loading}
					loadError={keys.loadError}
					busy={disconnectTarget === null ? null : "disconnect"}
					onRetry={() => void keys.reload()}
					onDisconnect={setDisconnectTarget}
				/>
			) : null}
			<div className="px-3 py-2.5">
				<CloudProviderConnectForm keys={keys} onChanged={onChanged} />
			</div>
			<CloudProviderDisconnectDialog
				keys={keys}
				target={disconnectTarget}
				onClose={() => setDisconnectTarget(null)}
				onChanged={onChanged}
			/>
		</>
	);
}
