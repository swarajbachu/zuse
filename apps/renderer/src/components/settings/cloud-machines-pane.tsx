import {
	type MachineOffer,
	MachineOpError,
	type MachinePrivateNetworkStatus,
	type MachineRecord,
	type MachineRuntimeStatus,
	type MachineSshKey,
	type SshMode,
} from "@zuse/contracts";
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
		: new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
				new Date(value),
			);

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
						label: "Cloud machine",
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
			const target = await runControlPlane((control) =>
				control["machine.runtime.target"](),
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
				<span className="sr-only">Loading cloud machine</span>
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
			{error === null ? null : (
				<div
					role="alert"
					className="rounded-md bg-alert-error-bg px-3 py-2 text-[11px] text-destructive-foreground ring-1 ring-inset ring-destructive/10"
				>
					{error}
				</div>
			)}

			{machine === null && offer !== null ? (
				<CloudSettingsGroup
					title="Persistent cloud machine"
					description="A private, always-on development computer managed by Zuse."
				>
					<CloudSettingsRow
						title={offer.displayName}
						description={`${offer.vcpuCount} vCPU · ${offer.memoryMib / 1024} GB memory · ${offer.diskGib} GB disk · ${offer.location}`}
						action={
							<div className="flex items-center gap-2">
								<p className="whitespace-nowrap text-[11px] text-muted-foreground">
									<span className="font-medium text-foreground">
										${(offer.monthlyPriceCents / 100).toFixed(0)}
									</span>{" "}
									/ month
								</p>
								<Button
									size="xs"
									loading={submitting}
									onClick={() => void beginPurchase()}
								>
									<ExternalLink aria-hidden />
									{checkoutUrl === null ? "Checkout" : "Reopen"}
								</Button>
							</div>
						}
					/>
					<CloudSettingsRow
						title="Backups and network"
						description="Automatic backups included. Public inbound traffic is blocked."
						action={<Badge variant="success">Included</Badge>}
					/>
					{checkoutUrl === null ? null : (
						<CloudSettingsRow
							title="Waiting for payment"
							description="Provisioning begins automatically when payment is confirmed. You can close this window."
							action={<Badge variant="warning">Checking</Badge>}
						/>
					)}
				</CloudSettingsGroup>
			) : null}

			{machine === null && offer === null && loadError === null ? (
				<CloudSettingsGroup
					title="Cloud machines"
					description="Persistent cloud machines are currently invite-only."
				>
					<CloudSettingsRow
						title="No offer available"
						description="This account does not currently have access to a cloud-machine offer."
						action={<Badge variant="outline">Unavailable</Badge>}
					/>
				</CloudSettingsGroup>
			) : null}

			{machine !== null && progress !== null ? (
				<>
					<CloudSettingsGroup
						title={machine.label ?? machine.offer.displayName}
						description="Your persistent provider-managed development computer."
						action={
							<Badge variant={progressVariant(progress.tone)}>
								{progress.label}
							</Badge>
						}
					>
						<CloudSettingsRow
							title="Machine"
							description={`${machine.offer.vcpuCount} vCPU · ${machine.offer.memoryMib / 1024} GB memory · ${machine.offer.diskGib} GB disk`}
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
									aria-label={`Provisioning step ${activeProgressStep + 1} of ${progressSteps.length}: ${progressSteps[activeProgressStep]}`}
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
									title="Managed connection"
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
													Open machine
												</Button>
											) : (
												<Button
													size="xs"
													variant="outline"
													loading={connectionBusy}
													onClick={() => void retryMachineConnection()}
												>
													Retry
												</Button>
											)}
										</>
									}
								/>
								<CloudSettingsRow
									title="Cloud runtime"
									description={
										runtimeStatus === null
											? runtimeStatusUnavailable
												? "This machine cannot report runtime updates yet. Older machines need one manual updater run."
												: "Checks automatically against this version of Zuse."
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
														? "Manual update needed"
														: "Checking"
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
													Update now
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
						<>
							<CloudAccountAccess environmentId={machineEnvironmentId} />
							<CloudSettingsGroup
								title="Private access"
								description="Optional private networking and SSH access for this machine."
							>
								<CloudSettingsRow
									title="Private network"
									description={
										network?.enabled === true
											? (network.dnsName ?? "Connected to your private network")
											: "Connect once with a reusable or ephemeral network auth key."
									}
									action={
										<>
											<Badge
												variant={
													network?.enabled === true ? "success" : "outline"
												}
											>
												{network?.enabled === true
													? "Enabled"
													: "Not configured"}
											</Badge>
											<Button
												size="xs"
												variant="outline"
												onClick={() => setNetworkDialogOpen(true)}
											>
												{network?.enabled === true ? "Reconnect" : "Set up"}
											</Button>
										</>
									}
								/>
								<CloudSettingsRow
									title="SSH mode"
									description={
										sshMode === "tailnet-identity"
											? "Network identity controls SSH access. Explicit ACL rules are required."
											: "Standard public keys authorize SSH access."
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
													SSH keys
												</SelectItem>
												<SelectItem value="tailnet-identity">
													Network identity
												</SelectItem>
											</SelectPopup>
										</Select>
									}
								/>
								<CloudSettingsRow
									title="Authorized keys"
									description={
										sshKeys.length === 0
											? "No SSH public keys have been added."
											: `${sshKeys.length} ${sshKeys.length === 1 ? "key" : "keys"} authorized`
									}
									action={
										<Button
											size="xs"
											variant="outline"
											disabled={network?.enabled !== true}
											onClick={() => setKeysDialogOpen(true)}
										>
											<KeyRound aria-hidden />
											Manage
										</Button>
									}
								/>
							</CloudSettingsGroup>
						</>
					) : null}

					<CloudSettingsGroup
						title="Plan and billing"
						description="Subscription dates and lifecycle controls for this machine."
					>
						<CloudSettingsRow
							title="Monthly plan"
							description={machine.offer.displayName}
							action={
								<span className="font-medium text-[11px]">
									${(machine.offer.monthlyPriceCents / 100).toFixed(0)} / month
								</span>
							}
						/>
						<CloudSettingsRow
							title="Paid through"
							description={formatDate(machine.paidThrough, "Manual alpha")}
						/>
						<CloudSettingsRow
							title="Recovery deadline"
							description={formatDate(
								machine.recoveryDeadline,
								"Not scheduled",
							)}
						/>
						<CloudSettingsRow
							title="Billing"
							description="Manage payment details and invoices in the billing portal."
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
									Open portal
								</Button>
							}
						/>
						{machine.state === "suspended" ? (
							<CloudSettingsRow
								title="Recover machine"
								description="Restore access before the recovery deadline."
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
										Recover
									</Button>
								}
							/>
						) : machine.desiredState === "ready" ? (
							<CloudSettingsRow
								title="Subscription"
								description="Keep using the machine until the end of the paid period."
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
										Cancel at period end
									</Button>
								}
							/>
						) : null}
					</CloudSettingsGroup>

					<CloudSettingsGroup
						title="Danger zone"
						description="Permanent actions for this cloud machine."
					>
						<CloudSettingsRow
							title="Destroy machine"
							description="Immediately revoke access, sanitize credentials, and schedule provider cleanup."
							action={
								<Button
									size="xs"
									variant="destructive-outline"
									disabled={action !== null || machine.state === "destroyed"}
									onClick={() => setDestroyDialogOpen(true)}
								>
									<Trash2 aria-hidden />
									Destroy
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
								<DialogTitle>Connect private network</DialogTitle>
								<DialogDescription>
									The auth key goes directly to this machine and is discarded
									after setup.
								</DialogDescription>
							</DialogHeader>
							<DialogPanel className="space-y-3">
								<label
									className="block space-y-1"
									htmlFor="private-network-key"
								>
									<span className="text-[11px] font-medium">Auth key</span>
									<Input
										id="private-network-key"
										type="password"
										value={networkKey}
										onChange={(event) => setNetworkKey(event.target.value)}
										placeholder="Paste an auth key"
										autoComplete="off"
										spellCheck={false}
										data-1p-ignore
									/>
								</label>
								<label
									className="block space-y-1"
									htmlFor="private-network-ssh-mode"
								>
									<span className="text-[11px] font-medium">SSH mode</span>
									<Select
										value={sshMode}
										onValueChange={(value) => setSshMode(value as SshMode)}
									>
										<SelectTrigger id="private-network-ssh-mode">
											<SelectValue />
										</SelectTrigger>
										<SelectPopup>
											<SelectItem value="authorized-keys">
												Standard SSH keys
											</SelectItem>
											<SelectItem value="tailnet-identity">
												Network identity SSH
											</SelectItem>
										</SelectPopup>
									</Select>
								</label>
							</DialogPanel>
							<DialogFooter>
								<DialogClose render={<Button size="xs" variant="ghost" />}>
									Cancel
								</DialogClose>
								<Button
									size="xs"
									loading={action === "network"}
									disabled={action !== null || networkKey.trim().length === 0}
									onClick={() => void enablePrivateNetwork()}
								>
									Connect
								</Button>
							</DialogFooter>
						</DialogPopup>
					</Dialog>

					<Dialog open={keysDialogOpen} onOpenChange={setKeysDialogOpen}>
						<DialogPopup className="max-w-md">
							<DialogHeader>
								<DialogTitle>Authorized SSH keys</DialogTitle>
								<DialogDescription>
									Only these public keys can access the machine over its private
									network.
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
										SSH public key
									</label>
									<Input
										id="ssh-public-key"
										value={sshPublicKey}
										onChange={(event) => setSshPublicKey(event.target.value)}
										placeholder="ssh-ed25519 …"
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
										Add
									</Button>
								</form>
								<div className="overflow-hidden rounded-md border border-border/60">
									{sshKeys.length === 0 ? (
										<p className="px-3 py-3 text-[11px] text-muted-foreground">
											No keys added yet.
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
															{key.label ?? "SSH key"}
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
														Remove
													</Button>
												</div>
											))}
										</div>
									)}
								</div>
							</DialogPanel>
							<DialogFooter>
								<DialogClose render={<Button size="xs" variant="ghost" />}>
									Done
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
								<AlertDialogTitle>Update cloud runtime?</AlertDialogTitle>
								<AlertDialogDescription>
									The signed runtime and developer tools will be updated to
									match Zuse {runtimeTargetVersion ?? ""}. Active terminals and
									agents may briefly reconnect during the service restart.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogClose render={<Button size="xs" variant="ghost" />}>
									Cancel
								</AlertDialogClose>
								<Button
									size="xs"
									loading={runtimeUpdateBusy}
									onClick={() => void updateRuntime()}
								>
									Update runtime
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
								<AlertDialogTitle>Destroy this cloud machine?</AlertDialogTitle>
								<AlertDialogDescription>
									Access ends immediately. Credentials are removed before any
									final snapshot, and provider cleanup is scheduled.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogClose render={<Button size="xs" variant="ghost" />}>
									Keep machine
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
									Destroy machine
								</Button>
							</AlertDialogFooter>
						</AlertDialogPopup>
					</AlertDialog>
				</>
			) : null}
		</section>
	);
}
