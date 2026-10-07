import "@zuse/i18n/english/settings";
import type {
	CloudProviderConnection,
	CloudProviderConnectionInput,
} from "@zuse/contracts";
import { formatDate } from "@zuse/i18n";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Check, ChevronRight, KeyRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "~/lib/utils";
import { cloudProviderLabel } from "../../lib/cloud-provider-presentation.ts";
import { runCloudControl } from "../../lib/control-plane-client.ts";
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
	CloudSettingsGroup,
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

export function CloudProviderKeys({
	onChanged,
}: {
	readonly onChanged: () => Promise<void>;
}) {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);
	const [connections, setConnections] = useState<
		readonly CloudProviderConnection[] | null
	>(null);
	const [providerId, setProviderId] = useState<ProviderId>("boxd");
	const [apiKey, setApiKey] = useState("");
	const [templateId, setTemplateId] = useState("");
	const [organization, setOrganization] = useState("");
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [disconnectTarget, setDisconnectTarget] =
		useState<CloudProviderConnection | null>(null);
	const [disconnectError, setDisconnectError] = useState<string | null>(null);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const result = await runCloudControl((client) =>
				client["cloud.providerConnections.list"](),
			);
			if (!mounted.current) return;
			setConnections(result.connections);
			setLoadError(false);
		} catch {
			if (mounted.current) setLoadError(true);
		} finally {
			if (mounted.current) setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const active = (connections ?? []).filter((connection) => connection.active);
	const replacing = active.some(
		(connection) => connection.providerId === providerId,
	);
	const providerName = cloudProviderLabel(providerId);

	const selectProvider = (value: ProviderId) => {
		setProviderId(value);
		setApiKey("");
		setTemplateId("");
		setOrganization("");
		setError(null);
	};

	const save = async () => {
		if (busy !== null) return;
		setBusy("save");
		setError(null);
		try {
			const result = await runCloudControl((client) =>
				client["cloud.providerConnections.save"]({
					providerId,
					apiKey: apiKey.trim(),
					templateId: templateId.trim() || undefined,
					organization:
						providerId === "boxd"
							? organization.trim() || undefined
							: undefined,
				}),
			);
			if (!mounted.current) return;
			setConnections(result.connections);
			setApiKey("");
			setTemplateId("");
			setOrganization("");
			setAdvancedOpen(false);
			await onChanged();
		} catch {
			if (mounted.current)
				setError(
					uiMessage("settings:cloud_provider_keys_save_failed", {
						provider: providerName,
					}),
				);
		} finally {
			if (mounted.current) setBusy(null);
		}
	};

	const disconnect = async (connection: CloudProviderConnection) => {
		if (busy !== null) return;
		setBusy(`disconnect:${connection.connectionId}`);
		setDisconnectError(null);
		try {
			const result = await runCloudControl((client) =>
				client["cloud.providerConnections.disconnect"]({
					connectionId: connection.connectionId,
				}),
			);
			if (!mounted.current) return;
			setConnections(result.connections);
			setDisconnectTarget(null);
			await onChanged();
		} catch {
			if (mounted.current)
				setDisconnectError(
					uiMessage("settings:cloud_provider_keys_disconnect_failed"),
				);
		} finally {
			if (mounted.current) setBusy(null);
		}
	};

	const disconnectTargetName =
		disconnectTarget === null
			? ""
			: cloudProviderLabel(disconnectTarget.providerId);

	return (
		<CloudSettingsGroup
			title={uiMessage("settings:cloud_provider_keys_title")}
			help={`${uiMessage("settings:cloud_provider_keys_description")} ${uiMessage("settings:cloud_provider_keys_footer")}`}
		>
			<CloudProviderKeyList
				connections={connections}
				loading={loading}
				loadError={loadError}
				busy={busy}
				onRetry={() => void load()}
				onDisconnect={(connection) => {
					setDisconnectError(null);
					setDisconnectTarget(connection);
				}}
			/>
			<CloudSettingsRow
				title={
					replacing
						? uiMessage("settings:cloud_provider_keys_replace_title", {
								provider: providerName,
							})
						: uiMessage("settings:cloud_provider_keys_connect_title")
				}
				description={
					replacing
						? uiMessage("settings:cloud_provider_keys_replace_description")
						: uiMessage("settings:cloud_provider_keys_connect_description", {
								provider: providerName,
							})
				}
			>
				<form
					className="flex flex-col gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (apiKey.trim().length > 0) void save();
					}}
				>
					<div className="flex items-center gap-2">
						<Select
							value={providerId}
							disabled={busy !== null}
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
							disabled={busy !== null}
							aria-invalid={error !== null && busy === null ? true : undefined}
							onChange={(event) => {
								setApiKey(event.target.value);
								setError(null);
							}}
						/>
						<Button
							type="submit"
							size="xs"
							className={COMPACT_CLOUD_ACTION}
							disabled={busy !== null || connections === null || !apiKey.trim()}
							loading={busy === "save"}
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
										aria-label={uiMessage(
											"settings:cloud_provider_keys_template",
										)}
										placeholder={uiMessage(
											"settings:cloud_provider_keys_template",
										)}
										className="h-7 min-w-0 flex-1 text-xs"
										spellCheck={false}
										value={templateId}
										disabled={busy !== null}
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
											disabled={busy !== null}
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
			</CloudSettingsRow>
			<AlertDialog
				open={disconnectTarget !== null}
				onOpenChange={(open) => {
					if (!open && busy === null) setDisconnectTarget(null);
				}}
			>
				<AlertDialogPopup className="max-w-sm">
					<AlertDialogHeader>
						<AlertDialogTitle>
							{uiMessage("settings:cloud_provider_keys_disconnect_title", {
								provider: disconnectTargetName,
							})}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{uiMessage(
								"settings:cloud_provider_keys_disconnect_description",
								{ provider: disconnectTargetName },
							)}
						</AlertDialogDescription>
						{disconnectError === null ? null : (
							<p role="alert" className="text-xs text-destructive">
								{disconnectError}
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
							variant="destructive"
							className={COMPACT_CLOUD_ACTION}
							loading={
								disconnectTarget !== null &&
								busy === `disconnect:${disconnectTarget.connectionId}`
							}
							onClick={() => {
								if (disconnectTarget !== null)
									void disconnect(disconnectTarget);
							}}
						>
							{uiMessage("settings:cloud_provider_keys_disconnect")}
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</CloudSettingsGroup>
	);
}
