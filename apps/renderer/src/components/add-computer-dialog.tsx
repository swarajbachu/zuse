import type { DiscoveredSshHost, SshEnvironmentTarget } from "@zuse/contracts";
import { Pencil, RotateCw, Trash2, Unplug } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import { describePairingLinkKind } from "../lib/pairing-link.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import {
	type EnvironmentCatalogEntry,
	useEnvironmentCatalogStore,
	validateSshTarget,
} from "../store/environment-catalog.ts";
import {
	AlertDialog,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
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
import { toastManager } from "./ui/toast.tsx";

const blankTarget = (): SshEnvironmentTarget => ({
	alias: "",
	hostname: "",
	username: null,
	port: null,
});

const errorText = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

type DialogView = "link" | "ssh" | "manage";

type AddComputerDialogOpenerState = {
	readonly open: boolean;
	readonly initialLink: string | null;
	readonly initialView: DialogView | null;
	readonly setOpen: (open: boolean) => void;
};

/**
 * Module-level opener so any surface (sidebar `+` button, deep-link accept,
 * command palette) can raise the dialog without threading props. The host
 * component below renders against this store.
 */
export const useAddComputerDialogStore = create<AddComputerDialogOpenerState>(
	(set) => ({
		open: false,
		initialLink: null,
		initialView: null,
		setOpen: (open) =>
			set(
				open
					? { open: true }
					: { open: false, initialLink: null, initialView: null },
			),
	}),
);

export const openAddComputerDialog = (options?: {
	readonly link?: string;
	readonly view?: DialogView;
}): void => {
	useAddComputerDialogStore.setState({
		open: true,
		initialLink: options?.link ?? null,
		initialView: options?.view ?? null,
	});
};

export function AddComputerDialogHost() {
	const open = useAddComputerDialogStore((state) => state.open);
	const initialLink = useAddComputerDialogStore((state) => state.initialLink);
	const initialView = useAddComputerDialogStore((state) => state.initialView);
	const setOpen = useAddComputerDialogStore((state) => state.setOpen);
	return (
		<AddComputerDialog
			open={open}
			onOpenChange={setOpen}
			initialLink={initialLink ?? undefined}
			initialView={initialView ?? undefined}
		/>
	);
}

const LINK_KIND_SUBTEXT: Record<
	"tailscale" | "relay" | "remote",
	{ readonly idle: string; readonly busy: string }
> = {
	tailscale: {
		idle: "Connects over Tailscale.",
		busy: "Connecting over Tailscale…",
	},
	relay: {
		idle: "Connects through the Zuse relay.",
		busy: "Connecting through the Zuse relay…",
	},
	remote: {
		idle: "Connects to a remote address.",
		busy: "Connecting to a remote address…",
	},
};

export const relayStatusText = (entry: EnvironmentCatalogEntry): string => {
	if (entry.status === "connected") return "Connected";
	if (entry.status === "connecting") return "Connecting…";
	if (entry.status === "error") return entry.error ?? "Connection failed";
	return "Offline";
};

export function StatusDot({
	status,
}: {
	readonly status: EnvironmentCatalogEntry["status"];
}) {
	return (
		<span
			aria-hidden="true"
			className={`size-2 shrink-0 rounded-full ${
				status === "connected"
					? "bg-emerald-500"
					: status === "error"
						? "bg-destructive"
						: status === "connecting"
							? "animate-pulse bg-muted-foreground/50 motion-reduce:animate-none"
							: "bg-muted-foreground/35"
			}`}
		/>
	);
}

export function AddComputerDialog({
	open,
	onOpenChange,
	initialLink,
	initialView,
}: {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly initialLink?: string;
	readonly initialView?: DialogView;
}) {
	const entries = useEnvironmentCatalogStore((state) => state.entries);
	const activeId = useEnvironmentCatalogStore(
		(state) => state.activeEnvironmentId,
	);
	const hiddenRelayIds = useEnvironmentCatalogStore(
		(state) => state.hiddenRelayEnvironmentIds,
	);
	const initialize = useEnvironmentCatalogStore((state) => state.initialize);
	const retry = useEnvironmentCatalogStore((state) => state.retry);
	const retryEnvironment = useEnvironmentCatalogStore(
		(state) => state.retryEnvironment,
	);
	const disconnect = useEnvironmentCatalogStore((state) => state.disconnect);
	const remove = useEnvironmentCatalogStore((state) => state.remove);
	const rename = useEnvironmentCatalogStore((state) => state.rename);
	const hideRelayEnvironment = useEnvironmentCatalogStore(
		(state) => state.hideRelayEnvironment,
	);
	const unhideRelayEnvironments = useEnvironmentCatalogStore(
		(state) => state.unhideRelayEnvironments,
	);

	const [view, setView] = useState<DialogView>("link");
	const [pairingLink, setPairingLink] = useState("");
	const [label, setLabel] = useState("");
	const [linkError, setLinkError] = useState<string | null>(null);
	const [submittingLink, setSubmittingLink] = useState(false);
	const [suggestions, setSuggestions] = useState<
		ReadonlyArray<DiscoveredSshHost>
	>([]);
	const [target, setTarget] = useState<SshEnvironmentTarget>(blankTarget);
	const [sshError, setSshError] = useState<string | null>(null);
	const [submittingSsh, setSubmittingSsh] = useState(false);
	const [manageError, setManageError] = useState<string | null>(null);
	const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
	const [editedLabel, setEditedLabel] = useState("");
	const [pendingRemoval, setPendingRemoval] = useState<{
		readonly profileId: string;
		readonly label: string;
	} | null>(null);

	// Fresh dialog on every open: reset to the link view, prefill a deep link
	// when one arrived, and make sure the catalog is hydrated.
	useEffect(() => {
		if (!open) return;
		setView(initialView ?? "link");
		setPairingLink(initialLink ?? "");
		setLabel("");
		setTarget(blankTarget());
		setLinkError(null);
		setSshError(null);
		setManageError(null);
		setEditingProfileId(null);
		setPendingRemoval(null);
		void initialize().catch((cause) => setLinkError(errorText(cause)));
	}, [open, initialLink, initialView, initialize]);

	// SSH host discovery is advanced-mode only; its failures never leak into
	// the pairing-link flow.
	useEffect(() => {
		if (!open || view !== "ssh") return;
		let cancelled = false;
		void window.zuse?.ssh
			?.discoverHosts()
			.then((hosts) => {
				if (!cancelled) setSuggestions(hosts);
			})
			.catch((cause) => {
				if (!cancelled) setSshError(errorText(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [open, view]);

	const profileEntries = entries.filter((entry) => entry.profileId !== null);
	const relayEntries = entries.filter(
		(entry) => entry.connectionKind === "relay",
	);
	const hasManageable = profileEntries.length > 0 || relayEntries.length > 0;
	const trimmedLink = pairingLink.trim();
	const linkKind = describePairingLinkKind(trimmedLink);
	const linkSubtext =
		trimmedLink.length > 0 && linkKind !== "invalid"
			? LINK_KIND_SUBTEXT[linkKind][submittingLink ? "busy" : "idle"]
			: null;

	const submitLink = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (submittingLink) return;
		if (trimmedLink.length === 0) {
			setLinkError("Paste the connect link from the other computer.");
			return;
		}
		setSubmittingLink(true);
		setLinkError(null);
		try {
			const connectedLabel = await useEnvironmentCatalogStore
				.getState()
				.addTailnet(trimmedLink, label.trim() || undefined);
			toastManager.add({
				title: `Connected to ${connectedLabel}`,
				type: "success",
			});
			setPairingLink("");
			setLabel("");
			onOpenChange(false);
		} catch (cause) {
			setLinkError(errorText(cause));
		} finally {
			setSubmittingLink(false);
		}
	};

	const submitSsh = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (submittingSsh) return;
		const hostname = target.hostname.trim();
		const validationError = validateSshTarget({ ...target, hostname });
		if (validationError !== null) {
			setSshError(validationError);
			return;
		}
		setSubmittingSsh(true);
		setSshError(null);
		try {
			await useEnvironmentCatalogStore
				.getState()
				.add(
					{ ...target, alias: target.alias.trim() || hostname, hostname },
					label.trim() || undefined,
				);
			setTarget(blankTarget());
			setLabel("");
			onOpenChange(false);
		} catch (cause) {
			setSshError(errorText(cause));
		} finally {
			setSubmittingSsh(false);
		}
	};

	const chooseSuggestion = (host: DiscoveredSshHost): void => {
		setTarget({
			alias: host.alias,
			hostname: host.hostname,
			username: host.username,
			port: host.port,
		});
		setLabel(host.displayName);
		setSshError(null);
	};

	const confirmRemoval = (): void => {
		if (pendingRemoval === null) return;
		const { profileId } = pendingRemoval;
		setPendingRemoval(null);
		void remove(profileId).catch((cause) => setManageError(errorText(cause)));
	};

	return (
		<>
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogPopup className="max-w-xl">
					<DialogHeader className="pb-3">
						<DialogTitle>
							{view === "manage" ? "Your computers" : "Connect a computer"}
						</DialogTitle>
						<DialogDescription>
							{view === "manage"
								? "Rename, reconnect, or remove computers saved on this device."
								: initialLink !== undefined && pairingLink === initialLink
									? "Review this link, then press Connect to pair with the other computer."
									: "Use a connect link or your existing SSH setup."}
						</DialogDescription>
					</DialogHeader>
					<div className="min-h-0 space-y-3 overflow-y-auto px-4 pb-3">
						<div className="flex items-center justify-between gap-2">
							{view !== "manage" ? (
								<fieldset className="inline-flex rounded-md bg-muted p-0.5">
									<legend className="sr-only">Connection method</legend>
									<Button
										type="button"
										size="xs"
										variant={view === "link" ? "outline" : "ghost"}
										aria-pressed={view === "link"}
										onClick={() => {
											setView("link");
											setLinkError(null);
										}}
									>
										Connect link
									</Button>
									<Button
										type="button"
										size="xs"
										variant={view === "ssh" ? "outline" : "ghost"}
										aria-pressed={view === "ssh"}
										onClick={() => {
											setView("ssh");
											setSshError(null);
										}}
									>
										SSH
									</Button>
								</fieldset>
							) : (
								<span />
							)}
							{hasManageable || hiddenRelayIds.length > 0 ? (
								<Button
									type="button"
									size="xs"
									variant="ghost"
									onClick={() => {
										setView((current) =>
											current === "manage" ? "link" : "manage",
										);
										setManageError(null);
									}}
								>
									{view === "manage" ? "Add computer" : "Manage"}
								</Button>
							) : null}
						</div>

						{view === "manage" ? (
							<>
								{profileEntries.length > 0 ? (
									<section aria-labelledby="saved-computers-heading">
										<h3
											id="saved-computers-heading"
											className="mb-2 text-xs font-medium text-muted-foreground"
										>
											Saved computers
										</h3>
										<div className="space-y-1">
											{profileEntries.map((entry) => (
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
																			setManageError(errorText(cause)),
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
																`${entry.connectionKind === "tailnet" ? "Connect link" : (entry.target?.hostname ?? "SSH")} · ${entry.status}`}
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
																	(cause) => setManageError(errorText(cause)),
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
																void disconnect(
																	entry.profileId as string,
																).catch((cause) =>
																	setManageError(errorText(cause)),
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
														onClick={() =>
															setPendingRemoval({
																profileId: entry.profileId as string,
																label: entry.label,
															})
														}
													>
														<Trash2 />
													</Button>
												</div>
											))}
										</div>
									</section>
								) : null}
								{relayEntries.length > 0 ? (
									<section aria-labelledby="account-computers-heading">
										<h3
											id="account-computers-heading"
											className="mb-2 text-xs font-medium text-muted-foreground"
										>
											On your account
										</h3>
										<div className="space-y-1">
											{relayEntries.map((entry) => (
												<div
													key={entry.environmentId}
													className="flex min-h-11 items-center gap-2 rounded-lg border border-border/50 px-3 py-2"
												>
													<StatusDot status={entry.status} />
													<div className="min-w-0 flex-1">
														<div className="truncate text-sm font-medium">
															{entry.label}
														</div>
														<div className="truncate text-xs text-muted-foreground">
															{relayStatusText(entry)}
														</div>
													</div>
													{entry.status === "error" ? (
														<Button
															size="xs"
															variant="ghost"
															onClick={() =>
																void retryEnvironment(
																	entry.environmentId,
																).catch((cause) =>
																	setManageError(errorText(cause)),
																)
															}
														>
															Retry
														</Button>
													) : null}
													<Button
														disabled={entry.environmentId === activeId}
														size="xs"
														variant="ghost"
														onClick={() =>
															void hideRelayEnvironment(
																entry.environmentId,
															).catch((cause) =>
																setManageError(errorText(cause)),
															)
														}
													>
														Hide
													</Button>
												</div>
											))}
										</div>
									</section>
								) : null}
								{hiddenRelayIds.length > 0 ? (
									<Button
										size="xs"
										variant="ghost"
										onClick={() =>
											void unhideRelayEnvironments().catch((cause) =>
												setManageError(errorText(cause)),
											)
										}
									>
										Show hidden computers ({hiddenRelayIds.length})
									</Button>
								) : null}
								{manageError !== null ? (
									<p role="alert" className="text-xs text-destructive">
										{manageError}
									</p>
								) : null}
								<p className="text-xs text-muted-foreground">
									Removing a computer only forgets it here; its projects and
									data remain untouched.
								</p>
							</>
						) : null}

						{view === "link" ? (
							<>
								<form
									id="add-computer-link-form"
									className="space-y-3"
									onSubmit={(event) => void submitLink(event)}
								>
									<div className="rounded-lg bg-muted/30 p-3 text-xs text-muted-foreground">
										On the other computer, open Settings → Remote access →
										Connect a device, then copy the link. Any Zuse connect link
										works here.
									</div>
									<div>
										<label
											htmlFor="add-computer-link"
											className="mb-1 block text-xs font-medium"
										>
											Connect link
										</label>
										<Input
											id="add-computer-link"
											autoFocus
											autoComplete="off"
											value={pairingLink}
											onChange={(event) => setPairingLink(event.target.value)}
											placeholder="zuse:///connect/pair?..."
											aria-invalid={linkError !== null || undefined}
										/>
										<p
											className="mt-1 min-h-4 text-xs text-muted-foreground"
											aria-live="polite"
										>
											{linkSubtext}
										</p>
									</div>
									<div>
										<label
											htmlFor="add-computer-name"
											className="mb-1 block text-xs font-medium"
										>
											Computer name{" "}
											<span className="font-normal text-muted-foreground">
												Optional
											</span>
										</label>
										<Input
											id="add-computer-name"
											value={label}
											onChange={(event) => setLabel(event.target.value)}
											placeholder="Linux computer"
										/>
									</div>
								</form>
								{linkError !== null ? (
									<p role="alert" className="text-xs text-destructive">
										{linkError}
									</p>
								) : null}
								<section aria-labelledby="account-computers-list-heading">
									<h3
										id="account-computers-list-heading"
										className="mb-2 text-xs font-medium text-muted-foreground"
									>
										On your account
									</h3>
									{relayEntries.length === 0 ? (
										<p className="rounded-lg border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
											Computers signed in to your Zuse account appear here
											automatically.
										</p>
									) : (
										<div className="space-y-1">
											{relayEntries.map((entry) => (
												<div
													key={entry.environmentId}
													className="flex min-h-11 items-center gap-2 rounded-lg border border-border/50 px-3 py-2"
												>
													<StatusDot status={entry.status} />
													<div className="min-w-0 flex-1">
														<div className="truncate text-sm font-medium">
															{entry.label}
														</div>
														<div className="truncate text-xs text-muted-foreground">
															{relayStatusText(entry)}
														</div>
													</div>
													{entry.status === "error" ? (
														<Button
															size="xs"
															variant="ghost"
															onClick={() =>
																void retryEnvironment(
																	entry.environmentId,
																).catch((cause) =>
																	setLinkError(errorText(cause)),
																)
															}
														>
															Retry
														</Button>
													) : null}
												</div>
											))}
										</div>
									)}
								</section>
							</>
						) : null}

						{view === "ssh" ? (
							<>
								{suggestions.length > 0 ? (
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
								<form
									id="add-computer-ssh-form"
									className="space-y-3"
									onSubmit={(event) => void submitSsh(event)}
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
											aria-invalid={sshError !== null || undefined}
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
								{sshError !== null ? (
									<p role="alert" className="text-xs text-destructive">
										{sshError}
									</p>
								) : null}
							</>
						) : null}
					</div>
					<DialogFooter className="py-2">
						{view === "manage" ? (
							<Button onClick={() => onOpenChange(false)}>Done</Button>
						) : (
							<>
								<Button variant="ghost" onClick={() => onOpenChange(false)}>
									Cancel
								</Button>
								<Button
									form={
										view === "link"
											? "add-computer-link-form"
											: "add-computer-ssh-form"
									}
									type="submit"
									loading={view === "link" ? submittingLink : submittingSsh}
								>
									Connect
								</Button>
							</>
						)}
					</DialogFooter>
				</DialogPopup>
			</Dialog>
			<AlertDialog
				open={pendingRemoval !== null}
				onOpenChange={(alertOpen) => {
					if (!alertOpen) setPendingRemoval(null);
				}}
			>
				<AlertDialogPopup className="max-w-sm">
					<AlertDialogHeader>
						<AlertDialogTitle>Remove {pendingRemoval?.label}?</AlertDialogTitle>
						<AlertDialogDescription>
							Zuse will forget this computer on this device. Projects and data
							on {pendingRemoval?.label} are not deleted.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<Button variant="ghost" onClick={() => setPendingRemoval(null)}>
							Cancel
						</Button>
						<Button variant="destructive" onClick={confirmRemoval}>
							Remove
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</>
	);
}
