import { formatDate as formatUiDate } from "@zuse/i18n";
import { Effect } from "effect";
import { getLocalEnvironmentId, getRpcClient } from "../../lib/rpc-client.ts";
import "@zuse/i18n/english/settings";
import {
	type MachineOffer,
	MachineOpError,
	type MachinePrivateNetworkStatus,
	type MachineRecord,
	type MachineRuntimeStatus,
	type MachineSshKey,
	type SshMode,
} from "@zuse/contracts";
import { RichMessage, useMessages as useUiMessages } from "@zuse/i18n/react";
import { ExternalLink, KeyRound, LoaderCircle, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../hooks/use-auth.ts";
import {
	clearCloudMachineCheckoutSession,
	readCloudMachineCheckoutSession,
	writeCloudMachineCheckoutSession,
} from "../../lib/cloud-machine-checkout-session.ts";
import { cloudConnectionPresentation } from "../../lib/cloud-machine-connection.ts";
import {
	checkoutErrorMessage,
	visibleCloudMachineError,
} from "../../lib/cloud-machine-errors.ts";
import {
	cloudMachineProgress,
	cloudMachineProgressSteps,
} from "../../lib/cloud-machine-progress.ts";
import { selectActiveCloudMachine } from "../../lib/cloud-machine-selection.ts";
import { runControlPlane } from "../../lib/control-plane-client.ts";
import { dispatchEnvironmentShellCommand } from "../../lib/environment-shell-client-bus.ts";
import { hostedAccountId } from "../../lib/hosted-connect.ts";
import { openExternal } from "../../lib/platform-capabilities.ts";
import { switchToEnvironment } from "../../lib/switch-environment.ts";
import { useEnvironmentCatalogStore } from "../../store/environment-catalog.ts";
import { useUiStore } from "../../store/ui.ts";
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
	Dialog,
	DialogClose,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "../ui/dialog.tsx";
import { Input } from "../ui/input.tsx";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "../ui/select.tsx";
import { Spinner } from "../ui/spinner.tsx";
import { CloudAccountAccess } from "./cloud-account-access.tsx";
import { CloudSettingsGroup, CloudSettingsRow } from "./cloud-settings-ui.tsx";
import { CloudWorkspacePool } from "./cloud-workspace-pool.tsx";

const formatDate = (value: number | undefined, fallback: string): string =>
	value === undefined
		? fallback
		: formatUiDate(new Date(value), { dateStyle: "medium" });

const progressVariant = (
	tone: ReturnType<typeof cloudMachineProgress>["tone"],
): "success" | "warning" | "error" | "info" => {
	if (tone === "success") return "success";
	if (tone === "warning") return "warning";
	if (tone === "error") return "error";
	return "info";
};

export const runtimePhaseLabel = (status: MachineRuntimeStatus): string => {
	if (status.phase === "queued") return "Update queued";
	if (status.phase === "checking") return "Checking release";
	if (status.phase === "downloading") return "Downloading runtime";
	if (status.phase === "installing") return "Installing runtime";
	if (status.phase === "developer-tools") return "Updating developer tools";
	if (status.phase === "restarting") return "Restarting cloud services";
	if (status.phase === "verifying") return "Verifying connection";
	if (status.phase === "rolling-back") return "Restoring previous version";
	if (status.phase === "failed")
		return status.failureCode === "rollback-complete"
			? "Update failed; previous version restored"
			: "Update failed";
	if (status.state === "current") return "Up to date";
	if (status.state === "update-available") return "Update available";
	return "Version unavailable";
};

export const runtimeVersionDescription = (
	status: MachineRuntimeStatus,
): string => {
	const installed = status.installedAppVersion ?? "unknown";
	if (status.state === "updating") {
		return `Updating Zuse ${installed} to ${status.targetAppVersion}. Terminals and agents may reconnect briefly.`;
	}
	if (status.state === "current") {
		return `Installed Zuse ${installed}. This matches the desktop app.`;
	}
	if (status.state === "update-available") {
		return `Installed Zuse ${installed}; desktop requires ${status.targetAppVersion}.`;
	}
	return `Installed Zuse ${installed}; target ${status.targetAppVersion}.`;
};

export function CloudMachinesPane() {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	const { isLoading: authLoading, isSignedIn } = useAuth();
	const [offer, setOffer] = useState<MachineOffer | null>(null);
	const [machine, setMachine] = useState<MachineRecord | null>(null);
	const [loading, setLoading] = useState(true);
	const [submitting, setSubmitting] = useState(false);
	const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
	const [action, setAction] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [networkKey, setNetworkKey] = useState("");
	const [sshMode, setSshMode] = useState<SshMode>("authorized-keys");
	const [network, setNetwork] = useState<MachinePrivateNetworkStatus | null>(
		null,
	);
	const [sshPublicKey, setSshPublicKey] = useState("");
	const [sshKeys, setSshKeys] = useState<ReadonlyArray<MachineSshKey>>([]);
	const [networkDialogOpen, setNetworkDialogOpen] = useState(false);
	const [keysDialogOpen, setKeysDialogOpen] = useState(false);
	const [destroyDialogOpen, setDestroyDialogOpen] = useState(false);
	const [connectionBusy, setConnectionBusy] = useState(false);
	const [runtimeStatus, setRuntimeStatus] =
		useState<MachineRuntimeStatus | null>(null);
	const [runtimeStatusUnavailable, setRuntimeStatusUnavailable] =
		useState(false);
	const [runtimeTargetVersion, setRuntimeTargetVersion] = useState<
		string | null
	>(null);
	const [runtimeUpdateBusy, setRuntimeUpdateBusy] = useState(false);
	const [runtimeUpdateDialogOpen, setRuntimeUpdateDialogOpen] = useState(false);
	const machineEnvironmentId = machine?.environmentId;
	const machineCommand = useCallback(
		<Result, Payload = unknown>(kind: string, payload: Payload) => {
			if (machineEnvironmentId === undefined)
				return Promise.reject(new Error("Cloud machine is unavailable."));
			return dispatchEnvironmentShellCommand<Payload, Result>({
				environmentId: machineEnvironmentId as never,
				kind,
				commandId: crypto.randomUUID() as never,
				payload,
			}).then(({ result }) => result);
		},
		[machineEnvironmentId],
	);
	const machineEnvironment = useEnvironmentCatalogStore((state) =>
		machineEnvironmentId === undefined
			? undefined
			: state.entries.find(
					(entry) => entry.environmentId === machineEnvironmentId,
				),
	);
	const syncAccountEnvironments = useEnvironmentCatalogStore(
		(state) => state.syncAccountEnvironments,
	);
	const retryEnvironment = useEnvironmentCatalogStore(
		(state) => state.retryEnvironment,
	);
	const setView = useUiStore((state) => state.setView);

	const load = useCallback(async () => {
		try {
			const [offers, machines] = await Promise.all([
				runControlPlane((client) => client["machines.offers"]()),
				runControlPlane((client) => client["machines.list"]()),
			]);
			const nextOffer =
				offers.offers.find((candidate) => candidate.kind === "persistent") ??
				null;
			setOffer(nextOffer);
			const activeMachine = selectActiveCloudMachine(
				machines.machines,
				"persistent",
			);
			setMachine(activeMachine);
			if (
				activeMachine?.state === "ready" &&
				activeMachine.environmentId !== undefined &&
				!useEnvironmentCatalogStore
					.getState()
					.entries.some(
						(entry) => entry.environmentId === activeMachine.environmentId,
					)
			) {
				void syncAccountEnvironments().catch(() => undefined);
			}
			if (activeMachine !== null) {
				setCheckoutUrl(null);
				clearCloudMachineCheckoutSession(
					window.sessionStorage,
					activeMachine.offer.offerId,
				);
			} else if (nextOffer !== null) {
				setCheckoutUrl(
					readCloudMachineCheckoutSession(window.sessionStorage, {
						accountId: hostedAccountId(),
						nowMs: Date.now(),
						offerId: nextOffer.offerId,
					}),
				);
			}
			setLoadError(null);
		} catch {
			setLoadError(
				"Cloud machines are available only to signed-in alpha accounts.",
			);
		} finally {
			setLoading(false);
		}
	}, [syncAccountEnvironments]);

	useEffect(() => {
		if (authLoading) return;
		if (!isSignedIn) {
			setLoading(false);
			setLoadError(null);
			return;
		}
		void load();
		const handleFocus = () => void load();
		window.addEventListener("focus", handleFocus);
		return () => window.removeEventListener("focus", handleFocus);
	}, [authLoading, isSignedIn, load]);

	const beginPurchase = async () => {
		if (offer === null || submitting) return;
		setSubmitting(true);
		setActionError(null);
		try {
			if (checkoutUrl !== null) {
				await openExternal(checkoutUrl);
				return;
			}
			try {
				const checkout = await runControlPlane((client) =>
					client["machines.checkout"]({ offerId: offer.offerId }),
				);
				setCheckoutUrl(checkout.checkoutUrl);
				writeCloudMachineCheckoutSession(window.sessionStorage, {
					accountId: hostedAccountId(),
					nowMs: Date.now(),
					offerId: offer.offerId,
					url: checkout.checkoutUrl,
				});
				await openExternal(checkout.checkoutUrl);
			} catch (cause) {
				if (
					!(cause instanceof MachineOpError) ||
					cause.code !== "billing-unavailable"
				) {
					throw cause;
				}
				const created = await runControlPlane((client) =>
					client["machines.create"]({
						offerId: offer.offerId,
						label: uiMessage("settings:cloud_machines_pane_cloud_machine"),
						idempotencyKey: crypto.randomUUID(),
					}),
				);
				setMachine(created);
			}
		} catch (cause) {
			setActionError(checkoutErrorMessage(cause));
		} finally {
			setSubmitting(false);
		}
	};

	const machineAction = async (
		name: string,
		operation: () => Promise<MachineRecord>,
	) => {
		if (action !== null) return;
		setAction(name);
		setActionError(null);
		try {
			setMachine(await operation());
		} catch {
			setActionError("The machine could not be updated. Try again.");
		} finally {
			setAction(null);
		}
	};

	const refreshHostSettings = useCallback(async () => {
		if (
			machineEnvironmentId === undefined ||
			machineEnvironment?.status !== "connected"
		) {
			return;
		}
		try {
			const [status, keys] = await Promise.all([
				machineCommand<MachinePrivateNetworkStatus>(
					"machine.privateNetwork.status",
					{},
				),
				machineCommand<{ keys: ReadonlyArray<MachineSshKey> }>(
					"machine.sshKeys.list",
					{},
				),
			]);
			setNetwork(status);
			setSshMode(status.sshMode);
			setSshKeys(keys.keys);
		} catch {
			// Connection recovery remains owned by the environment catalog.
		}
	}, [machineCommand, machineEnvironment?.status, machineEnvironmentId]);

	useEffect(() => {
		void refreshHostSettings();
	}, [refreshHostSettings]);

	const refreshRuntimeStatus = useCallback(async () => {
		if (
			machineEnvironmentId === undefined ||
			machineEnvironment?.status !== "connected"
		) {
			return;
		}
		try {
			const target = await Effect.runPromise(
				(await getRpcClient(getLocalEnvironmentId()))[
					"machine.runtime.target"
				](),
			);
			setRuntimeTargetVersion(target.appVersion);
			const next = await machineCommand<MachineRuntimeStatus>(
				"machine.runtime.status",
				{
					targetAppVersion: target.appVersion,
				},
			);
			setRuntimeStatus(next);
			if (next.state === "current" || next.state === "updating") {
				setActionError((current) =>
					current === "The cloud runtime update could not be started."
						? null
						: current,
				);
				setRuntimeUpdateDialogOpen(false);
			}
			setRuntimeStatusUnavailable(false);
		} catch {
			setRuntimeStatusUnavailable(true);
			// Keep any last durable progress visible while the runtime reconnects.
		}
	}, [machineCommand, machineEnvironment?.status, machineEnvironmentId]);

	useEffect(() => {
		void refreshRuntimeStatus();
		if (runtimeStatus?.state !== "updating") return;
		const interval = window.setInterval(
			() => void refreshRuntimeStatus(),
			2_000,
		);
		return () => window.clearInterval(interval);
	}, [refreshRuntimeStatus, runtimeStatus?.state]);

	const updateRuntime = async () => {
		if (
			machineEnvironmentId === undefined ||
			runtimeTargetVersion === null ||
			runtimeUpdateBusy
		) {
			return;
		}
		setRuntimeUpdateBusy(true);
		setActionError(null);
		try {
			const next = await machineCommand<MachineRuntimeStatus>(
				"machine.runtime.update",
				{
					targetAppVersion: runtimeTargetVersion,
				},
			);
			setRuntimeStatus(next);
			setRuntimeUpdateDialogOpen(false);
		} catch {
			setActionError("The cloud runtime update could not be started.");
		} finally {
			setRuntimeUpdateBusy(false);
		}
	};

	const retryMachineConnection = async () => {
		if (connectionBusy) return;
		setConnectionBusy(true);
		setActionError(null);
		try {
			if (machineEnvironmentId === undefined) {
				await load();
			} else if (machineEnvironment === undefined) {
				await syncAccountEnvironments();
			} else {
				await retryEnvironment(machineEnvironmentId);
			}
		} catch {
			setActionError(
				"The secure connection could not be established. Try again.",
			);
		} finally {
			setConnectionBusy(false);
		}
	};

	const openMachine = async () => {
		if (machineEnvironmentId === undefined || connectionBusy) return;
		setConnectionBusy(true);
		setActionError(null);
		try {
			const result = await switchToEnvironment({
				environmentId: machineEnvironmentId,
			});
			if (result.switched) {
				setView("chat");
			} else {
				setActionError(
					"The machine is not connected yet. Retry the connection.",
				);
			}
		} catch {
			setActionError("The machine could not be opened. Retry the connection.");
		} finally {
			setConnectionBusy(false);
		}
	};

	const enablePrivateNetwork = async () => {
		if (machineEnvironmentId === undefined || networkKey.trim().length === 0)
			return;
		setAction("network");
		setActionError(null);
		try {
			const status = await machineCommand<MachinePrivateNetworkStatus>(
				"machine.privateNetwork.enable",
				{
					authKey: networkKey,
					sshMode,
				},
			);
			setNetwork(status);
			setNetworkDialogOpen(false);
		} catch {
			setActionError("Private networking could not be enabled.");
		} finally {
			setNetworkKey("");
			setAction(null);
		}
	};

	const updateSshMode = async (mode: SshMode) => {
		setSshMode(mode);
		if (machineEnvironmentId === undefined || network?.enabled !== true) return;
		setAction("ssh-mode");
		setActionError(null);
		try {
			setNetwork(
				await machineCommand<MachinePrivateNetworkStatus>(
					"machine.sshMode.set",
					{
						mode,
					},
				),
			);
		} catch {
			setActionError("The SSH mode could not be updated.");
			await refreshHostSettings();
		} finally {
			setAction(null);
		}
	};

	const addSshKey = async () => {
		if (machineEnvironmentId === undefined || sshPublicKey.trim().length === 0)
			return;
		setAction("ssh-key");
		setActionError(null);
		try {
			await machineCommand("machine.sshKeys.add", {
				publicKey: sshPublicKey.trim(),
			});
			setSshPublicKey("");
			await refreshHostSettings();
		} catch {
			setActionError("The SSH key could not be added.");
		} finally {
			setAction(null);
		}
	};

	const removeSshKey = async (fingerprint: string) => {
		if (machineEnvironmentId === undefined) return;
		setAction(`remove-key:${fingerprint}`);
		setActionError(null);
		try {
			await machineCommand("machine.sshKeys.remove", { fingerprint });
			await refreshHostSettings();
		} catch {
			setActionError("The SSH key could not be removed.");
		} finally {
			setAction(null);
		}
	};

	if (loading) {
		return (
			<div className="flex min-h-32 items-center justify-center" role="status">
				<Spinner className="text-muted-foreground" />
				<span className="sr-only">
					{uiMessage("settings:cloud_machines_pane_loading_cloud_machine")}
				</span>
			</div>
		);
	}

	const error = visibleCloudMachineError(loadError, actionError);
	const progress = machine === null ? null : cloudMachineProgress(machine);
	const progressSteps = machine === null ? [] : cloudMachineProgressSteps();
	const activeProgressStep = progress?.activeStep ?? null;
	const connection = cloudConnectionPresentation(
		machineEnvironment?.status,
		machineEnvironment?.error,
	);
	const connected = machineEnvironment?.status === "connected";

	return (
		<section className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3 text-xs">
			<CloudWorkspacePool />
			<CloudAccountAccess
				environmentId={
					connected && machineEnvironmentId !== undefined
						? machineEnvironmentId
						: undefined
				}
				unavailableReason={
					machine === null
						? "Create the persistent cloud computer below before configuring agent authentication."
						: "Reconnect the persistent cloud computer before managing agent authentication."
				}
			/>
			{error === null ? null : (
				<div
					role="alert"
					className="rounded-md bg-alert-error-bg px-3 py-2 text-[11px] text-destructive ring-1 ring-inset ring-destructive/10"
				>
					{error}
				</div>
			)}

			{machine === null && offer !== null ? (
				<CloudSettingsGroup
					title={uiMessage(
						"settings:cloud_machines_pane_persistent_cloud_machine",
					)}
					description={uiMessage(
						"settings:cloud_machines_pane_a_private_always_on_development_computer_managed_by_zuse",
					)}
				>
					<CloudSettingsRow
						title={offer.displayName}
						description={uiMessage(
							"settings:cloud_machines_pane_vcpu_gb_memory_gb_disk",
							{
								value1: String(offer.vcpuCount),
								value2: String(offer.memoryMib / 1024),
								value3: String(offer.diskGib),
								value4: String(offer.location),
							},
						)}
						action={
							<div className="flex items-center gap-2">
								<p className="whitespace-nowrap text-[11px] text-muted-foreground">
									<RichMessage
										id="settings:cloud_machines_pane_month_sentence"
										values={{
											value: (offer.monthlyPriceCents / 100).toFixed(0),
										}}
										components={{
											part0: <span className="font-medium text-foreground" />,
										}}
									/>
								</p>
								<Button
									size="xs"
									loading={submitting}
									onClick={() => void beginPurchase()}
								>
									<ExternalLink aria-hidden />
									{checkoutUrl === null
										? uiMessage("settings:cloud_machines_pane_checkout")
										: uiMessage("settings:cloud_machines_pane_reopen")}
								</Button>
							</div>
						}
					/>
					<CloudSettingsRow
						title={uiMessage(
							"settings:cloud_machines_pane_backups_and_network",
						)}
						description={uiMessage(
							"settings:cloud_machines_pane_automatic_backups_included_public_inbound_traffic_is_blocked",
						)}
						action={
							<Badge variant="success">
								{uiMessage("settings:cloud_machines_pane_included")}
							</Badge>
						}
					/>
					{checkoutUrl === null ? null : (
						<CloudSettingsRow
							title={uiMessage(
								"settings:cloud_machines_pane_waiting_for_payment",
							)}
							description={uiMessage(
								"settings:cloud_machines_pane_provisioning_begins_automatically_when_payment_is_confirmed_you_can_cl",
							)}
							action={
								<Badge variant="warning">
									{uiMessage("settings:cloud_machines_pane_checking")}
								</Badge>
							}
						/>
					)}
				</CloudSettingsGroup>
			) : null}

			{machine === null && offer === null && loadError === null ? (
				<CloudSettingsGroup
					title={uiMessage("settings:cloud_machines_pane_cloud_machines")}
					description={uiMessage(
						"settings:cloud_machines_pane_persistent_cloud_machines_are_currently_invite_only",
					)}
				>
					<CloudSettingsRow
						title={uiMessage("settings:cloud_machines_pane_no_offer_available")}
						description={uiMessage(
							"settings:cloud_machines_pane_this_account_does_not_currently_have_access_to_a_cloud_machine_offer",
						)}
						action={
							<Badge variant="outline">
								{uiMessage("settings:cloud_machines_pane_unavailable")}
							</Badge>
						}
					/>
				</CloudSettingsGroup>
			) : null}

			{machine !== null && progress !== null ? (
				<>
					<CloudSettingsGroup
						title={machine.label ?? machine.offer.displayName}
						description={uiMessage(
							"settings:cloud_machines_pane_your_persistent_provider_managed_development_computer",
						)}
						action={
							<Badge variant={progressVariant(progress.tone)}>
								{progress.label}
							</Badge>
						}
					>
						<CloudSettingsRow
							title={uiMessage("settings:cloud_machines_pane_machine")}
							description={uiMessage(
								"settings:cloud_machines_pane_vcpu_gb_memory_gb_disk_2",
								{
									value1: String(machine.offer.vcpuCount),
									value2: String(machine.offer.memoryMib / 1024),
									value3: String(machine.offer.diskGib),
								},
							)}
							action={
								<span className="text-[11px] text-muted-foreground">
									{machine.offer.location}
								</span>
							}
						/>
						<CloudSettingsRow
							title={progress.headline}
							description={progress.detail}
							action={
								<Badge variant={progressVariant(progress.tone)}>
									{progress.label}
								</Badge>
							}
						>
							{activeProgressStep === null ? null : (
								<div
									className="grid grid-cols-7 gap-1"
									aria-label={uiMessage(
										"settings:cloud_machines_pane_provisioning_step_of",
										{
											value1: String(activeProgressStep + 1),
											value2: String(progressSteps.length),
											value3: String(progressSteps[activeProgressStep]),
										},
									)}
									aria-valuemax={progressSteps.length}
									aria-valuemin={1}
									aria-valuenow={activeProgressStep + 1}
									role="progressbar"
								>
									{progressSteps.map((step, index) => (
										<span
											key={step}
											title={step}
											className={`h-1 rounded-full ${
												index <= activeProgressStep
													? progress.tone === "error" &&
														index === activeProgressStep
														? "bg-destructive"
														: progress.tone === "warning" &&
																index === activeProgressStep
															? "bg-warning"
															: "bg-foreground"
													: "bg-muted"
											}`}
										/>
									))}
								</div>
							)}
						</CloudSettingsRow>
						{machine.state !== "ready" ? null : (
							<>
								<CloudSettingsRow
									title={uiMessage(
										"settings:cloud_machines_pane_managed_connection",
									)}
									description={connection.description}
									action={
										<>
											<Badge variant={connection.variant}>
												{machineEnvironment?.status === "connecting" ||
												connectionBusy ? (
													<LoaderCircle className="animate-spin motion-reduce:animate-none" />
												) : null}
												{connection.label}
											</Badge>
											{connected && machineEnvironmentId !== undefined ? (
												<Button
													size="xs"
													loading={connectionBusy}
													onClick={() => void openMachine()}
												>
													{uiMessage(
														"settings:cloud_machines_pane_open_machine",
													)}
												</Button>
											) : (
												<Button
													size="xs"
													variant="outline"
													loading={connectionBusy}
													onClick={() => void retryMachineConnection()}
												>
													{uiMessage("common:retry")}
												</Button>
											)}
										</>
									}
								/>
								<CloudSettingsRow
									title={uiMessage(
										"settings:cloud_machines_pane_cloud_runtime",
									)}
									description={
										runtimeStatus === null
											? runtimeStatusUnavailable
												? uiMessage(
														"settings:cloud_machines_pane_runtime_updates_require_upgrade",
													)
												: uiMessage(
														"settings:cloud_machines_pane_checks_automatically_against_this_version_of_zuse",
													)
											: runtimeVersionDescription(runtimeStatus)
									}
									action={
										<>
											<Badge
												variant={
													runtimeStatus?.state === "current"
														? "success"
														: runtimeStatus?.state === "failed"
															? "warning"
															: runtimeStatusUnavailable
																? "warning"
																: "outline"
												}
											>
												{runtimeStatus === null
													? runtimeStatusUnavailable
														? uiMessage(
																"settings:cloud_machines_pane_manual_update_needed",
															)
														: uiMessage("settings:cloud_machines_pane_checking")
													: runtimePhaseLabel(runtimeStatus)}
											</Badge>
											{runtimeStatus?.state === "update-available" ||
											runtimeStatus?.state === "failed" ? (
												<Button
													size="xs"
													variant="outline"
													disabled={!connected || runtimeUpdateBusy}
													onClick={() => setRuntimeUpdateDialogOpen(true)}
												>
													{uiMessage("settings:cloud_machines_pane_update_now")}
												</Button>
											) : null}
										</>
									}
								>
									{runtimeStatus?.state === "updating" ? (
										<div
											className="h-1 overflow-hidden rounded-full bg-muted"
											role="progressbar"
											aria-label={runtimePhaseLabel(runtimeStatus)}
											aria-valuemin={0}
											aria-valuemax={100}
											aria-valuenow={runtimeStatus.progressPercent}
										>
											<span
												className="block h-full rounded-full bg-foreground transition-transform duration-200 ease-out motion-reduce:transition-none"
												style={{
													transform: `scaleX(${runtimeStatus.progressPercent / 100})`,
													transformOrigin: "left",
												}}
											/>
										</div>
									) : null}
								</CloudSettingsRow>
							</>
						)}
					</CloudSettingsGroup>
					{connected && machineEnvironmentId !== undefined ? (
						<CloudSettingsGroup
							title={uiMessage("settings:cloud_machines_pane_private_access")}
							description={uiMessage(
								"settings:cloud_machines_pane_optional_private_networking_and_ssh_access_for_this_machine",
							)}
						>
							<CloudSettingsRow
								title={uiMessage(
									"settings:cloud_machines_pane_private_network",
								)}
								description={
									network?.enabled === true
										? (network.dnsName ?? "Connected to your private network")
										: uiMessage(
												"settings:cloud_machines_pane_connect_once_with_a_reusable_or_ephemeral_network_auth_key",
											)
								}
								action={
									<>
										<Badge
											variant={
												network?.enabled === true ? "success" : "outline"
											}
										>
											{network?.enabled === true
												? uiMessage("settings:cloud_machines_pane_enabled")
												: uiMessage(
														"settings:cloud_machines_pane_not_configured",
													)}
										</Badge>
										<Button
											size="xs"
											variant="outline"
											onClick={() => setNetworkDialogOpen(true)}
										>
											{network?.enabled === true
												? uiMessage("settings:cloud_machines_pane_reconnect")
												: uiMessage("settings:cloud_machines_pane_set_up")}
										</Button>
									</>
								}
							/>
							<CloudSettingsRow
								title={uiMessage("settings:cloud_machines_pane_ssh_mode")}
								description={
									sshMode === "tailnet-identity"
										? uiMessage(
												"settings:cloud_machines_pane_network_identity_controls_ssh_access_explicit_acl_rules_are_required",
											)
										: uiMessage(
												"settings:cloud_machines_pane_standard_public_keys_authorize_ssh_access",
											)
								}
								action={
									<Select
										value={sshMode}
										disabled={network?.enabled !== true || action !== null}
										onValueChange={(value) =>
											void updateSshMode(value as SshMode)
										}
									>
										<SelectTrigger size="sm" className="w-36">
											<SelectValue />
										</SelectTrigger>
										<SelectPopup>
											<SelectItem value="authorized-keys">
												{uiMessage("settings:cloud_machines_pane_ssh_keys")}
											</SelectItem>
											<SelectItem value="tailnet-identity">
												{uiMessage(
													"settings:cloud_machines_pane_network_identity",
												)}
											</SelectItem>
										</SelectPopup>
									</Select>
								}
							/>
							<CloudSettingsRow
								title={uiMessage(
									"settings:cloud_machines_pane_authorized_keys",
								)}
								description={
									sshKeys.length === 0
										? uiMessage(
												"settings:cloud_machines_pane_no_ssh_public_keys_have_been_added",
											)
										: uiMessage("settings:cloud_machines_pane_authorized", {
												value1: String(sshKeys.length),
												value2: String(sshKeys.length === 1 ? "key" : "keys"),
											})
								}
								action={
									<Button
										size="xs"
										variant="outline"
										disabled={network?.enabled !== true}
										onClick={() => setKeysDialogOpen(true)}
									>
										<KeyRound aria-hidden />
										{uiMessage("settings:cloud_machines_pane_manage")}
									</Button>
								}
							/>
						</CloudSettingsGroup>
					) : null}

					<CloudSettingsGroup
						title={uiMessage("settings:cloud_machines_pane_plan_and_billing")}
						description={uiMessage(
							"settings:cloud_machines_pane_subscription_dates_and_lifecycle_controls_for_this_machine",
						)}
					>
						<CloudSettingsRow
							title={uiMessage("settings:cloud_machines_pane_monthly_plan")}
							description={machine.offer.displayName}
							action={
								<span className="font-medium text-[11px]">
									{uiMessage("settings:cloud_machines_pane_month_sentence_2", {
										value: (machine.offer.monthlyPriceCents / 100).toFixed(0),
									})}
								</span>
							}
						/>
						<CloudSettingsRow
							title={uiMessage("settings:cloud_machines_pane_paid_through")}
							description={formatDate(machine.paidThrough, "Manual alpha")}
						/>
						<CloudSettingsRow
							title={uiMessage(
								"settings:cloud_machines_pane_recovery_deadline",
							)}
							description={formatDate(
								machine.recoveryDeadline,
								"Not scheduled",
							)}
						/>
						<CloudSettingsRow
							title={uiMessage("settings:cloud_machines_pane_billing")}
							description={uiMessage(
								"settings:cloud_machines_pane_manage_payment_details_and_invoices_in_the_billing_portal",
							)}
							action={
								<Button
									size="xs"
									variant="outline"
									loading={action === "billing"}
									disabled={action !== null}
									onClick={() => {
										void (async () => {
											setAction("billing");
											setActionError(null);
											try {
												const portal = await runControlPlane((client) =>
													client["machines.billingPortal"](),
												);
												await openExternal(portal.portalUrl);
											} catch {
												setActionError(
													"Billing management is unavailable during the manual alpha.",
												);
											} finally {
												setAction(null);
											}
										})();
									}}
								>
									<ExternalLink aria-hidden />
									{uiMessage("settings:cloud_machines_pane_open_portal")}
								</Button>
							}
						/>
						{machine.state === "suspended" ? (
							<CloudSettingsRow
								title={uiMessage(
									"settings:cloud_machines_pane_recover_machine",
								)}
								description={uiMessage(
									"settings:cloud_machines_pane_restore_access_before_the_recovery_deadline",
								)}
								action={
									<Button
										size="xs"
										loading={action === "recover"}
										disabled={action !== null}
										onClick={() =>
											void machineAction("recover", async () => {
												return runControlPlane((client) =>
													client["machines.recover"]({
														machineId: machine.machineId,
													}),
												);
											})
										}
									>
										{uiMessage("settings:cloud_machines_pane_recover")}
									</Button>
								}
							/>
						) : machine.desiredState === "ready" ? (
							<CloudSettingsRow
								title={uiMessage("settings:cloud_machines_pane_subscription")}
								description={uiMessage(
									"settings:cloud_machines_pane_keep_using_the_machine_until_the_end_of_the_paid_period",
								)}
								action={
									<Button
										size="xs"
										variant="outline"
										loading={action === "cancel"}
										disabled={action !== null}
										onClick={() =>
											void machineAction("cancel", async () => {
												return runControlPlane((client) =>
													client["machines.cancel"]({
														machineId: machine.machineId,
													}),
												);
											})
										}
									>
										{uiMessage(
											"settings:cloud_machines_pane_cancel_at_period_end",
										)}
									</Button>
								}
							/>
						) : null}
					</CloudSettingsGroup>

					<CloudSettingsGroup
						title={uiMessage("settings:cloud_machines_pane_danger_zone")}
						description={uiMessage(
							"settings:cloud_machines_pane_permanent_actions_for_this_cloud_machine",
						)}
					>
						<CloudSettingsRow
							title={uiMessage("settings:cloud_machines_pane_destroy_machine")}
							description={uiMessage(
								"settings:cloud_machines_pane_immediately_revoke_access_sanitize_credentials_and_schedule_provider_c",
							)}
							action={
								<Button
									size="xs"
									variant="destructive-outline"
									disabled={action !== null || machine.state === "destroyed"}
									onClick={() => setDestroyDialogOpen(true)}
								>
									<Trash2 aria-hidden />
									{uiMessage("settings:cloud_machines_pane_destroy")}
								</Button>
							}
						/>
					</CloudSettingsGroup>

					<Dialog
						open={networkDialogOpen}
						onOpenChange={(open) => {
							setNetworkDialogOpen(open);
							if (!open) setNetworkKey("");
						}}
					>
						<DialogPopup className="max-w-sm">
							<DialogHeader>
								<DialogTitle>
									{uiMessage(
										"settings:cloud_machines_pane_connect_private_network",
									)}
								</DialogTitle>
								<DialogDescription>
									{uiMessage(
										"settings:cloud_machines_pane_the_auth_key_goes_directly_to_this_machine_and_is_discarded_after_setu",
									)}
								</DialogDescription>
							</DialogHeader>
							<DialogPanel className="space-y-3">
								<label
									className="block space-y-1"
									htmlFor="private-network-key"
								>
									<span className="text-[11px] font-medium">
										{uiMessage("settings:cloud_machines_pane_auth_key")}
									</span>
									<Input
										id="private-network-key"
										type="password"
										value={networkKey}
										onChange={(event) => setNetworkKey(event.target.value)}
										placeholder={uiMessage(
											"settings:cloud_machines_pane_paste_an_auth_key",
										)}
										autoComplete="off"
										spellCheck={false}
										data-1p-ignore
									/>
								</label>
								<label
									className="block space-y-1"
									htmlFor="private-network-ssh-mode"
								>
									<span className="text-[11px] font-medium">
										{uiMessage("settings:cloud_machines_pane_ssh_mode")}
									</span>
									<Select
										value={sshMode}
										onValueChange={(value) => setSshMode(value as SshMode)}
									>
										<SelectTrigger id="private-network-ssh-mode">
											<SelectValue />
										</SelectTrigger>
										<SelectPopup>
											<SelectItem value="authorized-keys">
												{uiMessage(
													"settings:cloud_machines_pane_standard_ssh_keys",
												)}
											</SelectItem>
											<SelectItem value="tailnet-identity">
												{uiMessage(
													"settings:cloud_machines_pane_network_identity_ssh",
												)}
											</SelectItem>
										</SelectPopup>
									</Select>
								</label>
							</DialogPanel>
							<DialogFooter>
								<DialogClose render={<Button size="xs" variant="ghost" />}>
									{uiMessage("common:cancel")}
								</DialogClose>
								<Button
									size="xs"
									loading={action === "network"}
									disabled={action !== null || networkKey.trim().length === 0}
									onClick={() => void enablePrivateNetwork()}
								>
									{uiMessage("common:connect")}
								</Button>
							</DialogFooter>
						</DialogPopup>
					</Dialog>

					<Dialog open={keysDialogOpen} onOpenChange={setKeysDialogOpen}>
						<DialogPopup className="max-w-md">
							<DialogHeader>
								<DialogTitle>
									{uiMessage(
										"settings:cloud_machines_pane_authorized_ssh_keys",
									)}
								</DialogTitle>
								<DialogDescription>
									{uiMessage(
										"settings:cloud_machines_pane_only_these_public_keys_can_access_the_machine_over_its_private_network",
									)}
								</DialogDescription>
							</DialogHeader>
							<DialogPanel className="space-y-3">
								<form
									className="flex gap-2"
									onSubmit={(event) => {
										event.preventDefault();
										void addSshKey();
									}}
								>
									<label className="sr-only" htmlFor="ssh-public-key">
										{uiMessage("settings:cloud_machines_pane_ssh_public_key")}
									</label>
									<Input
										id="ssh-public-key"
										value={sshPublicKey}
										onChange={(event) => setSshPublicKey(event.target.value)}
										placeholder={uiMessage(
											"settings:cloud_machines_pane_ssh_ed25519",
										)}
										autoComplete="off"
										spellCheck={false}
									/>
									<Button
										type="submit"
										size="sm"
										loading={action === "ssh-key"}
										disabled={
											action !== null || sshPublicKey.trim().length === 0
										}
									>
										{uiMessage("common:add")}
									</Button>
								</form>
								<div className="overflow-hidden rounded-md border border-border/60">
									{sshKeys.length === 0 ? (
										<p className="px-3 py-3 text-[11px] text-muted-foreground">
											{uiMessage(
												"settings:cloud_machines_pane_no_keys_added_yet",
											)}
										</p>
									) : (
										<div className="divide-y divide-border/40">
											{sshKeys.map((key) => (
												<div
													key={key.fingerprint}
													className="flex min-h-10 items-center gap-2 px-3 py-2"
												>
													<div className="min-w-0 flex-1">
														<p className="truncate text-xs font-medium">
															{key.label ??
																uiMessage(
																	"settings:cloud_machines_pane_ssh_key",
																)}
														</p>
														<p className="truncate text-[10px] text-muted-foreground">
															{key.fingerprint}
														</p>
													</div>
													<Button
														size="xs"
														variant="ghost"
														loading={action === `remove-key:${key.fingerprint}`}
														disabled={action !== null}
														onClick={() => void removeSshKey(key.fingerprint)}
													>
														{uiMessage("common:remove")}
													</Button>
												</div>
											))}
										</div>
									)}
								</div>
							</DialogPanel>
							<DialogFooter>
								<DialogClose render={<Button size="xs" variant="ghost" />}>
									{uiMessage("common:done")}
								</DialogClose>
							</DialogFooter>
						</DialogPopup>
					</Dialog>

					<AlertDialog
						open={runtimeUpdateDialogOpen}
						onOpenChange={setRuntimeUpdateDialogOpen}
					>
						<AlertDialogPopup className="max-w-sm">
							<AlertDialogHeader>
								<AlertDialogTitle>
									{uiMessage(
										"settings:cloud_machines_pane_update_cloud_runtime",
									)}
								</AlertDialogTitle>
								<AlertDialogDescription>
									{uiMessage(
										"settings:cloud_machines_pane_the_signed_runtime_and_developer_tools_will_be_updated_to_ma_sentence",
										{ value: runtimeTargetVersion ?? "" },
									)}
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogClose render={<Button size="xs" variant="ghost" />}>
									{uiMessage("common:cancel")}
								</AlertDialogClose>
								<Button
									size="xs"
									loading={runtimeUpdateBusy}
									onClick={() => void updateRuntime()}
								>
									{uiMessage("settings:cloud_machines_pane_update_runtime")}
								</Button>
							</AlertDialogFooter>
						</AlertDialogPopup>
					</AlertDialog>

					<AlertDialog
						open={destroyDialogOpen}
						onOpenChange={setDestroyDialogOpen}
					>
						<AlertDialogPopup>
							<AlertDialogHeader>
								<AlertDialogTitle>
									{uiMessage(
										"settings:cloud_machines_pane_destroy_this_cloud_machine",
									)}
								</AlertDialogTitle>
								<AlertDialogDescription>
									{uiMessage(
										"settings:cloud_machines_pane_access_ends_immediately_credentials_are_removed_before_any_final_snaps",
									)}
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogClose render={<Button size="xs" variant="ghost" />}>
									{uiMessage("settings:cloud_machines_pane_keep_machine")}
								</AlertDialogClose>
								<Button
									size="xs"
									variant="destructive"
									loading={action === "destroy"}
									disabled={action !== null}
									onClick={() => {
										void machineAction("destroy", async () => {
											const destroyed = await runControlPlane((client) =>
												client["machines.destroy"]({
													machineId: machine.machineId,
													confirmation: "destroy",
												}),
											);
											setDestroyDialogOpen(false);
											return destroyed;
										});
									}}
								>
									{uiMessage("settings:cloud_machines_pane_destroy_machine")}
								</Button>
							</AlertDialogFooter>
						</AlertDialogPopup>
					</AlertDialog>
				</>
			) : null}
		</section>
	);
}
