import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowDown01Icon,
	ComputerIcon,
} from "@hugeicons-pro/core-solid-rounded";
import {
	environmentRoute,
	parseEnvironmentRoute,
} from "@zuse/client-runtime/environment-scope";
import {
	type DiscoveredSshHost,
	HOSTED_APP_URL,
	type RelayEnvironmentRecord,
	type SshEnvironmentTarget,
} from "@zuse/contracts";
import { Effect } from "effect";
import { Pencil, Plus, RotateCw, Trash2, Unplug } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { getRpcClient } from "../lib/rpc-client.ts";
import {
	useEnvironmentCatalogStore,
	validateSshTarget,
} from "../store/environment-catalog.ts";
import { Button } from "./ui/button.tsx";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPopup,
	DialogTitle,
} from "./ui/dialog.tsx";
import { Input } from "./ui/input.tsx";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

const blankTarget = (): SshEnvironmentTarget => ({
	alias: "",
	hostname: "",
	username: null,
	port: null,
});

export function ComputerSwitcher() {
	return window.zuse?.ssh === undefined &&
		window.zuse?.tailnet === undefined ? (
		<HostedComputerSwitcher />
	) : (
		<DesktopComputerSwitcher />
	);
}

function DesktopComputerSwitcher() {
	const entries = useEnvironmentCatalogStore((state) => state.entries);
	const activeId = useEnvironmentCatalogStore(
		(state) => state.activeEnvironmentId,
	);
	const initialize = useEnvironmentCatalogStore((state) => state.initialize);
	const retry = useEnvironmentCatalogStore((state) => state.retry);
	const disconnect = useEnvironmentCatalogStore((state) => state.disconnect);
	const remove = useEnvironmentCatalogStore((state) => state.remove);
	const rename = useEnvironmentCatalogStore((state) => state.rename);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [managingSaved, setManagingSaved] = useState(false);
	const [connectionMode, setConnectionMode] = useState<"tailnet" | "ssh">(
		"tailnet",
	);
	const [pairingLink, setPairingLink] = useState("");
	const [suggestions, setSuggestions] = useState<
		ReadonlyArray<DiscoveredSshHost>
	>([]);
	const [target, setTarget] = useState<SshEnvironmentTarget>(blankTarget);
	const [label, setLabel] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
	const [editedLabel, setEditedLabel] = useState("");

	useEffect(() => {
		void initialize().catch((cause) =>
			setError(cause instanceof Error ? cause.message : String(cause)),
		);
	}, [initialize]);

	useEffect(() => {
		if (!dialogOpen) return;
		let cancelled = false;
		void window.zuse?.ssh
			?.discoverHosts()
			.then((hosts) => {
				if (!cancelled) setSuggestions(hosts);
			})
			.catch((cause) => {
				if (!cancelled)
					setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [dialogOpen]);

	const chooseSuggestion = (host: DiscoveredSshHost): void => {
		setTarget({
			alias: host.alias,
			hostname: host.hostname,
			username: host.username,
			port: host.port,
		});
		setLabel(host.displayName);
		setError(null);
	};

	const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
		event.preventDefault();
		if (submitting) return;
		const hostname = target.hostname.trim();
		const validationError = validateSshTarget({ ...target, hostname });
		if (validationError !== null) {
			setError(validationError);
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			await useEnvironmentCatalogStore
				.getState()
				.add(
					{ ...target, alias: target.alias.trim() || hostname, hostname },
					label.trim() || undefined,
				);
			setTarget(blankTarget());
			setLabel("");
			setDialogOpen(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSubmitting(false);
		}
	};
	const submitTailnet = async (
		event: FormEvent<HTMLFormElement>,
	): Promise<void> => {
		event.preventDefault();
		if (submitting) return;
		if (pairingLink.trim().length === 0) {
			setError("Paste the pairing link from the other computer.");
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			await useEnvironmentCatalogStore
				.getState()
				.addTailnet(pairingLink.trim(), label.trim() || undefined);
			setPairingLink("");
			setLabel("");
			setDialogOpen(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<>
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							type="button"
							aria-label="Add computer"
							className="relative flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
							onClick={() => setDialogOpen(true)}
						>
							<Plus aria-hidden="true" className="size-3.5" />
						</button>
					}
				/>
				<TooltipPopup>Add computer</TooltipPopup>
			</Tooltip>
			<Dialog
				open={dialogOpen}
				onOpenChange={(open) => {
					setDialogOpen(open);
					if (!open) setManagingSaved(false);
				}}
			>
				<DialogPopup className="max-w-xl">
					<DialogHeader>
						<DialogTitle>
							{managingSaved ? "Connected computers" : "Connect a computer"}
						</DialogTitle>
						<DialogDescription>
							{managingSaved
								? "Rename, reconnect, or remove computers saved on this device."
								: connectionMode === "tailnet"
									? "Paste a private connection link from the other computer. No address or port setup."
									: "Connect using an existing OpenSSH configuration."}
						</DialogDescription>
					</DialogHeader>
					<div className="min-h-0 space-y-5 overflow-y-auto px-5 pb-2">
						<div className="flex min-h-8 justify-end gap-1">
							{entries.some((entry) => entry.profileId !== null) ? (
								<Button
									type="button"
									size="xs"
									variant="ghost"
									onClick={() => {
										setManagingSaved((current) => !current);
										setError(null);
									}}
								>
									{managingSaved ? "Add a computer" : "Manage saved computers"}
								</Button>
							) : null}
							{!managingSaved ? (
								<Button
									type="button"
									size="xs"
									variant="ghost"
									onClick={() => {
										setConnectionMode((current) =>
											current === "tailnet" ? "ssh" : "tailnet",
										);
										setError(null);
									}}
								>
									{connectionMode === "tailnet"
										? "Use SSH"
										: "Back to private link"}
								</Button>
							) : null}
						</div>
						{managingSaved &&
						entries.some((entry) => entry.profileId !== null) ? (
							<section aria-labelledby="saved-computers-heading">
								<h3
									id="saved-computers-heading"
									className="mb-2 text-xs font-medium text-muted-foreground"
								>
									Saved computers
								</h3>
								<div className="space-y-1">
									{entries
										.filter((entry) => entry.profileId !== null)
										.map((entry) => (
											<div
												key={entry.profileId}
												className="flex min-h-11 items-center gap-2 rounded-lg border border-border/50 px-3 py-2"
											>
												<div className="min-w-0 flex-1">
													{editingProfileId === entry.profileId ? (
														<form
															className="flex gap-1"
															onSubmit={(event) => {
																event.preventDefault();
																if (entry.profileId === null) return;
																void rename(entry.profileId, editedLabel)
																	.then(() => setEditingProfileId(null))
																	.catch((cause) =>
																		setError(
																			cause instanceof Error
																				? cause.message
																				: String(cause),
																		),
																	);
															}}
														>
															<Input
																aria-label={`Label for ${entry.label}`}
																autoFocus
																value={editedLabel}
																onChange={(event) =>
																	setEditedLabel(event.target.value)
																}
															/>
															<Button size="sm" type="submit">
																Save
															</Button>
														</form>
													) : (
														<div className="truncate text-sm font-medium">
															{entry.label}
														</div>
													)}
													<div className="truncate text-xs text-muted-foreground">
														{entry.error ??
															`${entry.connectionKind === "tailnet" ? "Tailscale" : (entry.target?.hostname ?? "SSH")} · ${entry.status}`}
													</div>
												</div>
												<Button
													aria-label={`Edit label for ${entry.label}`}
													size="icon-sm"
													variant="ghost"
													onClick={() => {
														setEditingProfileId(entry.profileId);
														setEditedLabel(entry.label);
													}}
												>
													<Pencil />
												</Button>
												{entry.status !== "connected" ? (
													<Button
														aria-label={`Retry ${entry.label}`}
														size="icon-sm"
														variant="ghost"
														onClick={() =>
															void retry(entry.profileId as string).catch(
																(cause) =>
																	setError(
																		cause instanceof Error
																			? cause.message
																			: String(cause),
																	),
															)
														}
													>
														<RotateCw />
													</Button>
												) : (
													<Button
														aria-label={`Disconnect ${entry.label}`}
														disabled={entry.environmentId === activeId}
														size="icon-sm"
														variant="ghost"
														onClick={() =>
															void disconnect(entry.profileId as string).catch(
																(cause) =>
																	setError(
																		cause instanceof Error
																			? cause.message
																			: String(cause),
																	),
															)
														}
													>
														<Unplug />
													</Button>
												)}
												<Button
													aria-label={`Remove ${entry.label}`}
													disabled={entry.environmentId === activeId}
													size="icon-sm"
													variant="ghost"
													onClick={() => {
														if (
															window.confirm(
																`Remove ${entry.label}? Remote projects and data will not be deleted.`,
															)
														) {
															void remove(entry.profileId as string).catch(
																(cause) =>
																	setError(
																		cause instanceof Error
																			? cause.message
																			: String(cause),
																	),
															);
														}
													}}
												>
													<Trash2 />
												</Button>
											</div>
										))}
								</div>
							</section>
						) : null}

						{!managingSaved ? (
							<>
								{connectionMode === "ssh" && suggestions.length > 0 ? (
									<section aria-labelledby="suggested-computers-heading">
										<h3
											id="suggested-computers-heading"
											className="mb-2 text-xs font-medium text-muted-foreground"
										>
											Suggestions
										</h3>
										<div className="grid gap-1 sm:grid-cols-2">
											{suggestions.map((host) => (
												<Button
													key={`${host.source}:${host.alias}`}
													variant="outline"
													className="h-auto min-h-11 justify-start px-3 py-2 text-left"
													onClick={() => chooseSuggestion(host)}
												>
													<span className="min-w-0">
														<span className="block truncate text-sm">
															{host.displayName}
														</span>
														<span className="block truncate text-xs font-normal text-muted-foreground">
															{host.source === "tailscale"
																? "Tailnet"
																: "SSH config"}{" "}
															· {host.hostname}
														</span>
													</span>
												</Button>
											))}
										</div>
									</section>
								) : null}

								{connectionMode === "tailnet" ? (
									<form
										id="add-tailnet-computer-form"
										className="space-y-3"
										onSubmit={(event) => void submitTailnet(event)}
									>
										<div className="rounded-lg bg-muted/30 p-3 text-xs text-muted-foreground">
											On the other computer, open Settings → Devices and choose
											Connect device. Paste the link it creates below.
										</div>
										<div>
											<label
												htmlFor="tailnet-pairing-link"
												className="mb-1 block text-xs font-medium"
											>
												Pairing link
											</label>
											<Input
												id="tailnet-pairing-link"
												autoFocus
												autoComplete="off"
												value={pairingLink}
												onChange={(event) => setPairingLink(event.target.value)}
												placeholder="zuse:///connect/pair?..."
												aria-invalid={error !== null || undefined}
											/>
										</div>
										<div>
											<label
												htmlFor="tailnet-computer-label"
												className="mb-1 block text-xs font-medium"
											>
												Computer name{" "}
												<span className="font-normal text-muted-foreground">
													Optional
												</span>
											</label>
											<Input
												id="tailnet-computer-label"
												value={label}
												onChange={(event) => setLabel(event.target.value)}
												placeholder="Linux computer"
											/>
										</div>
									</form>
								) : (
									<form
										id="add-computer-form"
										className="space-y-3"
										onSubmit={(event) => void submit(event)}
									>
										<div>
											<label
												htmlFor="computer-host"
												className="mb-1 block text-xs font-medium"
											>
												Host
											</label>
											<Input
												id="computer-host"
												autoComplete="off"
												value={target.hostname}
												onChange={(event) =>
													setTarget((current) => ({
														...current,
														hostname: event.target.value,
														alias: event.target.value,
													}))
												}
												aria-invalid={error !== null || undefined}
												placeholder="server.example.com"
											/>
										</div>
										<div className="grid gap-3 sm:grid-cols-2">
											<div>
												<label
													htmlFor="computer-user"
													className="mb-1 block text-xs font-medium"
												>
													Username{" "}
													<span className="font-normal text-muted-foreground">
														Optional
													</span>
												</label>
												<Input
													id="computer-user"
													autoComplete="username"
													value={target.username ?? ""}
													onChange={(event) =>
														setTarget((current) => ({
															...current,
															username: event.target.value || null,
														}))
													}
												/>
											</div>
											<div>
												<label
													htmlFor="computer-port"
													className="mb-1 block text-xs font-medium"
												>
													Port{" "}
													<span className="font-normal text-muted-foreground">
														Optional
													</span>
												</label>
												<Input
													id="computer-port"
													inputMode="numeric"
													value={target.port ?? ""}
													onChange={(event) =>
														setTarget((current) => ({
															...current,
															port:
																event.target.value === ""
																	? null
																	: Number(event.target.value),
														}))
													}
												/>
											</div>
											<div className="sm:col-span-2">
												<label
													htmlFor="computer-label"
													className="mb-1 block text-xs font-medium"
												>
													Label{" "}
													<span className="font-normal text-muted-foreground">
														Optional
													</span>
												</label>
												<Input
													id="computer-label"
													value={label}
													onChange={(event) => setLabel(event.target.value)}
													placeholder="Build computer"
												/>
											</div>
										</div>
									</form>
								)}
							</>
						) : null}
						{error !== null ? (
							<p role="alert" className="text-xs text-destructive">
								{error}
							</p>
						) : null}
						{managingSaved ? (
							<p className="text-xs text-muted-foreground">
								Removing a computer only forgets it here; its projects and data
								remain untouched.
							</p>
						) : null}
					</div>
					<DialogFooter>
						{managingSaved ? (
							<Button onClick={() => setDialogOpen(false)}>Done</Button>
						) : (
							<>
								<Button variant="ghost" onClick={() => setDialogOpen(false)}>
									Cancel
								</Button>
								<Button
									form={
										connectionMode === "tailnet"
											? "add-tailnet-computer-form"
											: "add-computer-form"
									}
									type="submit"
									loading={submitting}
								>
									Connect
								</Button>
							</>
						)}
					</DialogFooter>
				</DialogPopup>
			</Dialog>
		</>
	);
}

const ONLINE_WINDOW_MS = 90_000;

const routeEnvironmentId = (): string | null => {
	return parseEnvironmentRoute(window.location.pathname)?.environmentId ?? null;
};

const relativeTime = (timestamp: number | undefined): string => {
	if (timestamp === undefined) return "Never seen";
	const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
	if (seconds < 60) return "Just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
};

const openEnvironment = (environmentId: string): void => {
	const url = `${HOSTED_APP_URL}${environmentRoute(environmentId)}`;
	if (window.location.origin === HOSTED_APP_URL) {
		window.location.assign(url);
		return;
	}
	const bridge = window.zuse?.app;
	if (bridge !== undefined) {
		bridge.openExternal(url);
		return;
	}
	window.open(url, "_blank", "noopener,noreferrer");
};

function HostedComputerSwitcher() {
	const [environments, setEnvironments] = useState<
		ReadonlyArray<RelayEnvironmentRecord>
	>([]);
	const [localEnvironmentId, setLocalEnvironmentId] = useState<string | null>(
		null,
	);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		let cancelled = false;
		const refresh = async (): Promise<void> => {
			try {
				const client = await getRpcClient();
				const [status, catalog] = await Promise.all([
					Effect.runPromise(client["relay.status"]()),
					Effect.runPromise(client["relay.environments"]()),
				]);
				if (!cancelled) {
					setLocalEnvironmentId(status.environmentId ?? null);
					setEnvironments(catalog.environments);
					setFailed(false);
				}
			} catch {
				if (!cancelled) setFailed(true);
			}
		};
		void refresh();
		const timer = window.setInterval(refresh, 30_000);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, []);
	const selectedId = routeEnvironmentId() ?? localEnvironmentId;
	const selected = useMemo(
		() =>
			environments.find(
				(environment) => environment.environmentId === selectedId,
			) ?? null,
		[environments, selectedId],
	);

	if (failed && environments.length === 0) return null;

	return (
		<div className="border-b border-sidebar-border/40 px-2 py-2">
			<Menu>
				<MenuTrigger
					aria-label="Switch computer"
					className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
				>
					<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent text-sidebar-accent-foreground">
						<HugeiconsIcon icon={ComputerIcon} className="size-4" />
					</span>
					<span className="min-w-0 flex-1">
						<span className="block truncate text-xs font-medium">
							{selected?.label ?? "This computer"}
						</span>
						<span className="block truncate text-[10px] text-muted-foreground">
							{selected === null
								? "Local workspace"
								: selected.lastHeartbeat !== undefined &&
										Date.now() - selected.lastHeartbeat <= ONLINE_WINDOW_MS
									? "Online"
									: `Offline · ${relativeTime(selected.lastHeartbeat)}`}
						</span>
					</span>
					<HugeiconsIcon
						aria-hidden="true"
						icon={ArrowDown01Icon}
						className="size-3.5 text-muted-foreground"
					/>
				</MenuTrigger>
				<MenuPopup
					align="start"
					className="w-[min(22rem,calc(100vw-1rem))]"
					side="bottom"
				>
					<div className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">
						Computers
					</div>
					{environments.map((environment) => {
						const online =
							environment.lastHeartbeat !== undefined &&
							Date.now() - environment.lastHeartbeat <= ONLINE_WINDOW_MS;
						const active = environment.environmentId === selectedId;
						return (
							<MenuItem
								key={environment.environmentId}
								className="min-h-11 items-start py-2"
								onClick={() =>
									active
										? undefined
										: openEnvironment(environment.environmentId)
								}
							>
								<span
									aria-hidden="true"
									className={`mt-1.5 size-2 shrink-0 rounded-full ${online ? "bg-emerald-500" : "bg-muted-foreground/35"}`}
								/>
								<span className="min-w-0 flex-1">
									<span className="flex items-center gap-2">
										<span className="truncate font-medium">
											{environment.label ?? "Unnamed computer"}
										</span>
										{active ? (
											<span className="text-[10px] text-muted-foreground">
												Current
											</span>
										) : null}
									</span>
									<span className="block truncate text-[11px] text-muted-foreground">
										{online
											? "Online"
											: relativeTime(environment.lastHeartbeat)}
										{environment.runtimeVersion
											? ` · v${environment.runtimeVersion}`
											: ""}
									</span>
								</span>
							</MenuItem>
						);
					})}
					{environments.length === 0 ? (
						<div className="px-2 py-3 text-xs text-muted-foreground">
							No served computers are linked to this account yet.
						</div>
					) : null}
				</MenuPopup>
			</Menu>
		</div>
	);
}
