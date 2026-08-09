import {
	type MachineOffer,
	MachineOpError,
	type MachinePrivateNetworkStatus,
	type MachineRecord,
	type MachineSshKey,
	type SshMode,
} from "@zuse/contracts";
import { Effect } from "effect";
import { useCallback, useEffect, useState } from "react";
import {
	clearCloudMachineCheckoutSession,
	readCloudMachineCheckoutSession,
	writeCloudMachineCheckoutSession,
} from "../../lib/cloud-machine-checkout-session.ts";
import {
	checkoutErrorMessage,
	visibleCloudMachineError,
} from "../../lib/cloud-machine-errors.ts";
import {
	cloudMachineProgress,
	cloudMachineProgressSteps,
} from "../../lib/cloud-machine-progress.ts";
import { selectActiveCloudMachine } from "../../lib/cloud-machine-selection.ts";
import { hostedAccountId } from "../../lib/hosted-connect.ts";
import { openExternal } from "../../lib/platform-capabilities.ts";
import {
	getControlPlaneRpcClient,
	getRpcClient,
} from "../../lib/rpc-client.ts";
import { switchToEnvironment } from "../../lib/switch-environment.ts";
import { useEnvironmentCatalogStore } from "../../store/environment-catalog.ts";
import { useUiStore } from "../../store/ui.ts";
import { Button } from "../ui/button.tsx";
import { Card } from "../ui/card.tsx";
import { Input } from "../ui/input.tsx";
import { CloudAccountAccess } from "./cloud-account-access.tsx";

export function CloudMachinesPane() {
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
	const machineEnvironmentId = machine?.environmentId;
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
	const setView = useUiStore((state) => state.setView);

	const load = useCallback(async () => {
		try {
			const client = await getControlPlaneRpcClient();
			const [offers, machines] = await Promise.all([
				Effect.runPromise(client["machines.offers"]()),
				Effect.runPromise(client["machines.list"]()),
			]);
			const nextOffer = offers.offers[0] ?? null;
			setOffer(nextOffer);
			const activeMachine = selectActiveCloudMachine(machines.machines);
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
				void syncAccountEnvironments().catch(() => {
					// The next machine poll retries discovery. Once present, the
					// catalog's normal retry surface owns connection failures.
				});
			}
			if (activeMachine !== null) {
				setCheckoutUrl(null);
				clearCloudMachineCheckoutSession(window.sessionStorage);
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
		void load();
		const timer = window.setInterval(() => void load(), 5_000);
		const handleFocus = () => void load();
		window.addEventListener("focus", handleFocus);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener("focus", handleFocus);
		};
	}, [load]);

	const beginPurchase = async () => {
		if (offer === null || submitting) return;
		setSubmitting(true);
		setActionError(null);
		try {
			if (checkoutUrl !== null) {
				await openExternal(checkoutUrl);
				return;
			}
			const client = await getControlPlaneRpcClient();
			try {
				const checkout = await Effect.runPromise(
					client["machines.checkout"]({
						offerId: offer.offerId,
					}),
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
				const created = await Effect.runPromise(
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
		)
			return;
		try {
			const client = await getRpcClient(machineEnvironmentId);
			const [status, keys] = await Promise.all([
				Effect.runPromise(client["machine.privateNetwork.status"]()),
				Effect.runPromise(client["machine.sshKeys.list"]()),
			]);
			setNetwork(status);
			setSshMode(status.sshMode);
			setSshKeys(keys.keys);
		} catch {
			// The normal connection recovery surface owns transport failures.
		}
	}, [machineEnvironment?.status, machineEnvironmentId]);

	useEffect(() => {
		void refreshHostSettings();
	}, [refreshHostSettings]);

	if (loading) {
		return (
			<div className="h-64 animate-pulse rounded-xl border border-border bg-muted/20" />
		);
	}

	const error = visibleCloudMachineError(loadError, actionError);
	const progress = machine === null ? null : cloudMachineProgress(machine);
	const activeProgressStep = progress?.activeStep ?? null;

	return (
		<div className="max-w-2xl space-y-4">
			{error !== null ? (
				<div
					role="alert"
					className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm"
				>
					{error}
				</div>
			) : null}

			{machine === null && offer !== null ? (
				<Card className="space-y-5 p-5">
					<div>
						<h2 className="font-semibold text-base">{offer.displayName}</h2>
						<p className="mt-1 text-muted-foreground text-sm">
							{offer.vcpuCount} vCPU · {offer.memoryMib / 1024} GB memory ·{" "}
							{offer.diskGib} GB disk · {offer.location}
						</p>
					</div>
					<div className="flex items-end justify-between gap-4">
						<div>
							<p className="font-semibold text-2xl">
								${(offer.monthlyPriceCents / 100).toFixed(0)}
								<span className="font-normal text-muted-foreground text-sm">
									/month
								</span>
							</p>
							<p className="text-muted-foreground text-xs">
								Automatic backups included. No public inbound ports.
							</p>
						</div>
						<Button
							type="button"
							disabled={submitting}
							onClick={() => void beginPurchase()}
							className="min-h-11"
						>
							{submitting
								? "Opening…"
								: checkoutUrl === null
									? "Continue to checkout"
									: "Reopen checkout"}
						</Button>
					</div>
					{checkoutUrl === null ? (
						<p className="h-5 text-muted-foreground text-xs">
							Provisioning starts automatically after payment.
						</p>
					) : (
						<div
							role="status"
							aria-live="polite"
							className="flex min-h-20 items-start gap-3 rounded-lg border border-border bg-muted/20 p-3"
						>
							<span
								aria-hidden="true"
								className="mt-1 size-2 shrink-0 animate-pulse rounded-full bg-foreground motion-reduce:animate-none"
							/>
							<div>
								<p className="font-medium text-sm">
									Waiting for payment confirmation
								</p>
								<p className="mt-1 text-muted-foreground text-xs">
									Your cloud machine will be provisioned automatically once
									payment is confirmed. You can safely return to this window.
								</p>
							</div>
						</div>
					)}
				</Card>
			) : null}

			{machine !== null && progress !== null ? (
				<Card className="space-y-5 p-5">
					<div className="flex items-start justify-between gap-3">
						<div>
							<h2 className="font-semibold text-base">
								{machine.label ?? machine.offer.displayName}
							</h2>
							<p className="mt-1 text-muted-foreground text-sm">
								{machine.offer.location} · {progress.label}
							</p>
						</div>
						{machineEnvironmentId !== undefined && machine.state === "ready" ? (
							<Button
								type="button"
								disabled={machineEnvironment?.status !== "connected"}
								onClick={() => {
									void switchToEnvironment({
										environmentId: machineEnvironmentId,
									}).then((result) => {
										if (result.switched) setView("chat");
									});
								}}
								className="min-h-11"
							>
								{machineEnvironment?.status === "connected"
									? "Open machine"
									: "Connecting…"}
							</Button>
						) : null}
					</div>

					<div
						role={progress.tone === "error" ? "alert" : "status"}
						aria-live="polite"
						className={`min-h-20 rounded-lg border p-3 ${
							progress.tone === "error"
								? "border-destructive/30 bg-destructive/5"
								: progress.tone === "warning"
									? "border-amber-500/30 bg-amber-500/5"
									: "border-border bg-muted/20"
						}`}
					>
						<p className="font-medium text-sm">{progress.headline}</p>
						<p className="mt-1 text-muted-foreground text-xs">
							{progress.detail}
						</p>
					</div>

					{activeProgressStep !== null ? (
						<section className="min-h-24" aria-label="Machine setup progress">
							<ol className="grid grid-cols-7 gap-2">
								{cloudMachineProgressSteps.map((step, index) => {
									const complete = index <= activeProgressStep;
									const current = index === activeProgressStep;
									return (
										<li
											key={step}
											className="min-w-0"
											aria-current={current ? "step" : undefined}
										>
											<div
												className={`h-1.5 rounded-full ${
													complete
														? current && progress.tone === "error"
															? "bg-destructive"
															: current && progress.tone === "warning"
																? "bg-amber-500"
																: "bg-foreground"
														: "bg-muted"
												}`}
											/>
											<p
												className={`mt-2 text-xs ${
													current ? "text-foreground" : "text-muted-foreground"
												}`}
											>
												{step}
											</p>
										</li>
									);
								})}
							</ol>
						</section>
					) : null}

					<div className="rounded-lg border border-border p-3 text-sm">
						<p className="font-medium">Connection and SSH</p>
						<p className="mt-1 text-muted-foreground text-xs">
							Managed connection is always available. Open the machine to add a
							private network, manage authorized keys, or opt into
							identity-based SSH.
						</p>
					</div>

					<div className="grid min-h-16 grid-cols-2 gap-3 rounded-lg border border-border p-3 text-xs">
						<div>
							<p className="text-muted-foreground">Paid through</p>
							<p className="mt-1 font-medium">
								{machine.paidThrough === undefined
									? "Manual alpha"
									: new Date(machine.paidThrough).toLocaleDateString()}
							</p>
						</div>
						<div>
							<p className="text-muted-foreground">Recovery deadline</p>
							<p className="mt-1 font-medium">
								{machine.recoveryDeadline === undefined
									? "Not scheduled"
									: new Date(machine.recoveryDeadline).toLocaleDateString()}
							</p>
						</div>
					</div>

					{machineEnvironmentId !== undefined &&
					machineEnvironment?.status === "connected" ? (
						<>
							<CloudAccountAccess environmentId={machineEnvironmentId} />
							<div className="space-y-4 rounded-lg border border-border p-3">
								<div>
									<p className="font-medium text-sm">Private networking</p>
									<p className="mt-1 text-muted-foreground text-xs">
										The key is sent directly to this machine and is never saved.
									</p>
								</div>
								<div className="flex gap-2">
									<label className="sr-only" htmlFor="private-network-key">
										Private-network auth key
									</label>
									<Input
										id="private-network-key"
										type="password"
										value={networkKey}
										onChange={(event) => setNetworkKey(event.target.value)}
										placeholder="Auth key"
										autoComplete="off"
										className="min-h-11"
									/>
									<Button
										type="button"
										disabled={networkKey.length === 0 || action !== null}
										onClick={() => {
											void (async () => {
												setAction("network");
												try {
													const client =
														await getRpcClient(machineEnvironmentId);
													const status = await Effect.runPromise(
														client["machine.privateNetwork.enable"]({
															authKey: networkKey,
															sshMode,
														}),
													);
													setNetwork(status);
												} catch {
													setActionError(
														"Private networking could not be enabled.",
													);
												} finally {
													setNetworkKey("");
													setAction(null);
												}
											})();
										}}
										className="min-h-11"
									>
										Connect
									</Button>
								</div>
								<fieldset className="space-y-2">
									<legend className="font-medium text-sm">SSH mode</legend>
									{(
										[
											["authorized-keys", "Standard SSH keys"],
											["tailnet-identity", "Identity-based SSH"],
										] as const
									).map(([mode, label]) => (
										<label
											key={mode}
											className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-sm"
										>
											<input
												type="radio"
												name="ssh-mode"
												value={mode}
												checked={sshMode === mode}
												onChange={() => {
													setSshMode(mode);
													if (network?.enabled === true) {
														void (async () => {
															const client =
																await getRpcClient(machineEnvironmentId);
															const status = await Effect.runPromise(
																client["machine.sshMode.set"]({ mode }),
															);
															setNetwork(status);
														})();
													}
												}}
											/>
											{label}
										</label>
									))}
									{sshMode === "tailnet-identity" ? (
										<p className="text-amber-600 text-xs">
											Your network ACL must explicitly allow SSH access to this
											machine.
										</p>
									) : null}
								</fieldset>
								{sshMode === "authorized-keys" ? (
									<div className="space-y-2">
										<label
											htmlFor="ssh-public-key"
											className="font-medium text-sm"
										>
											Authorized keys
										</label>
										<div className="flex gap-2">
											<Input
												id="ssh-public-key"
												value={sshPublicKey}
												onChange={(event) =>
													setSshPublicKey(event.target.value)
												}
												placeholder="ssh-ed25519 …"
												className="min-h-11"
											/>
											<Button
												type="button"
												disabled={sshPublicKey.length === 0}
												onClick={() => {
													void (async () => {
														const client =
															await getRpcClient(machineEnvironmentId);
														await Effect.runPromise(
															client["machine.sshKeys.add"]({
																publicKey: sshPublicKey,
															}),
														);
														setSshPublicKey("");
														await refreshHostSettings();
													})();
												}}
												className="min-h-11"
											>
												Add
											</Button>
										</div>
										{sshKeys.map((key) => (
											<div
												key={key.fingerprint}
												className="flex min-h-11 items-center gap-2 text-xs"
											>
												<span className="min-w-0 flex-1 truncate">
													{key.label ?? key.fingerprint}
												</span>
												<Button
													type="button"
													variant="ghost"
													onClick={() => {
														void (async () => {
															const client =
																await getRpcClient(machineEnvironmentId);
															await Effect.runPromise(
																client["machine.sshKeys.remove"]({
																	fingerprint: key.fingerprint,
																}),
															);
															await refreshHostSettings();
														})();
													}}
												>
													Remove
												</Button>
											</div>
										))}
									</div>
								) : null}
							</div>
						</>
					) : null}

					<div className="flex flex-wrap gap-2 border-border border-t pt-4">
						<Button
							type="button"
							variant="outline"
							disabled={action !== null}
							onClick={() => {
								void (async () => {
									setAction("billing");
									try {
										const client = await getControlPlaneRpcClient();
										const portal = await Effect.runPromise(
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
							className="min-h-11"
						>
							Billing
						</Button>
						{machine.state === "suspended" ? (
							<Button
								type="button"
								disabled={action !== null}
								onClick={() =>
									void machineAction("recover", async () => {
										const client = await getControlPlaneRpcClient();
										return Effect.runPromise(
											client["machines.recover"]({
												machineId: machine.machineId,
											}),
										);
									})
								}
								className="min-h-11"
							>
								Recover machine
							</Button>
						) : machine.desiredState === "ready" ? (
							<Button
								type="button"
								variant="outline"
								disabled={action !== null}
								onClick={() =>
									void machineAction("cancel", async () => {
										const client = await getControlPlaneRpcClient();
										return Effect.runPromise(
											client["machines.cancel"]({
												machineId: machine.machineId,
											}),
										);
									})
								}
								className="min-h-11"
							>
								Cancel at period end
							</Button>
						) : null}
						<Button
							type="button"
							variant="destructive"
							disabled={action !== null || machine.state === "destroyed"}
							onClick={() => {
								if (
									!window.confirm(
										"Destroy this machine now? Access ends immediately. A sanitized final snapshot is kept temporarily only when credential cleanup can be verified.",
									)
								) {
									return;
								}
								void machineAction("destroy", async () => {
									const client = await getControlPlaneRpcClient();
									return Effect.runPromise(
										client["machines.destroy"]({
											machineId: machine.machineId,
											confirmation: "destroy",
										}),
									);
								});
							}}
							className="min-h-11"
						>
							Destroy now…
						</Button>
					</div>
				</Card>
			) : null}
		</div>
	);
}
