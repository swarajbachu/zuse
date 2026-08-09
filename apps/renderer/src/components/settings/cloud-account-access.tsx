import type {
	AccountAccessProvider,
	AccountAccessProviderStatus,
	AccountAccessSealedCredential,
	AccountAccessTransferEvent,
	LocalAccountDescriptor,
} from "@zuse/contracts";
import { Effect, Stream } from "effect";
import { useCallback, useEffect, useMemo, useState } from "react";
import { openExternal } from "../../lib/platform-capabilities.ts";
import {
	getControlPlaneRpcClient,
	getRpcClient,
} from "../../lib/rpc-client.ts";
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

const PROVIDERS = ["github", "claude", "codex"] as const;
const PROVIDER_LABEL: Record<AccountAccessProvider, string> = {
	github: "GitHub",
	claude: "Claude",
	codex: "Codex",
};

type RowProgress = {
	readonly providerId: AccountAccessProvider;
	readonly message: string;
	readonly code?: string;
	readonly url?: string;
};

const statusBadge = (
	status: AccountAccessProviderStatus | undefined,
): {
	readonly label: string;
	readonly variant: "success" | "warning" | "outline";
} => {
	if (status?.state === "connected")
		return { label: "Connected", variant: "success" };
	if (status?.state === "missing-tool")
		return { label: "Tool missing", variant: "warning" };
	return { label: "Not connected", variant: "outline" };
};

export function CloudAccountAccess({
	environmentId,
}: {
	readonly environmentId: string;
}) {
	const [statuses, setStatuses] = useState<
		ReadonlyArray<AccountAccessProviderStatus>
	>([]);
	const [localAccounts, setLocalAccounts] = useState<
		ReadonlyArray<LocalAccountDescriptor>
	>([]);
	const [loading, setLoading] = useState(true);
	const [pendingProvider, setPendingProvider] =
		useState<AccountAccessProvider | null>(null);
	const [busyProvider, setBusyProvider] =
		useState<AccountAccessProvider | null>(null);
	const [progress, setProgress] = useState<RowProgress | null>(null);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const [environment, control] = await Promise.all([
				getRpcClient(environmentId),
				getControlPlaneRpcClient(),
			]);
			const [remote, local] = await Promise.all([
				Effect.runPromise(environment["accountAccess.status"]()),
				Effect.runPromise(control["accountAccess.detectLocal"]()),
			]);
			setStatuses(remote.providers);
			setLocalAccounts(local.accounts);
			setError(null);
		} catch {
			setError("Account access could not be checked. Reconnect and try again.");
		} finally {
			setLoading(false);
		}
	}, [environmentId]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const statusByProvider = useMemo(
		() => new Map(statuses.map((status) => [status.providerId, status])),
		[statuses],
	);
	const localByProvider = useMemo(
		() =>
			new Map(localAccounts.map((account) => [account.providerId, account])),
		[localAccounts],
	);

	const runSetup = async (providerId: AccountAccessProvider) => {
		setPendingProvider(null);
		setBusyProvider(providerId);
		setProgress({ providerId, message: "Waiting for authorization…" });
		setError(null);
		try {
			const [environment, control] = await Promise.all([
				getRpcClient(environmentId),
				getControlPlaneRpcClient(),
			]);
			if (providerId === "claude") {
				const session = await Effect.runPromise(control["auth.getSession"]({}));
				if (session._tag !== "SignedIn") throw new Error("not-signed-in");
				const prepared = await Effect.runPromise(
					environment["accountAccess.prepareImport"]({
						accountId: session.session.user.id,
						providerId: "claude",
					}),
				);
				let sealed: AccountAccessSealedCredential | null = null;
				await Effect.runPromise(
					Stream.runForEach(
						control["accountAccess.createClaudeTransfer"]({ prepared }),
						(event: AccountAccessTransferEvent) =>
							Effect.promise(async () => {
								if (event._tag === "verification") {
									await openExternal(event.url);
									setProgress({
										providerId,
										message: "Finish authorization in your browser.",
										url: event.url,
										code: event.code,
									});
								} else if (event._tag === "sealed") {
									sealed = event.sealed;
								} else if (event._tag === "done" && !event.ok) {
									throw new Error(event.reason ?? "login-failed");
								}
							}),
					),
				);
				if (sealed === null) throw new Error("transfer-rejected");
				await Effect.runPromise(
					environment["accountAccess.import"]({
						transferId: prepared.transferId,
						sealed,
					}),
				);
			} else {
				await Effect.runPromise(
					Stream.runForEach(
						environment["accountAccess.startLogin"]({ providerId }),
						(event: AccountAccessTransferEvent) =>
							Effect.promise(async () => {
								if (event._tag === "verification") {
									await openExternal(event.url);
									setProgress({
										providerId,
										message: "Enter the code in your browser.",
										url: event.url,
										code: event.code,
									});
								} else if (event._tag === "done" && !event.ok) {
									throw new Error(event.reason ?? "login-failed");
								}
							}),
					),
				);
			}
			setProgress({ providerId, message: "Connected." });
			await refresh();
		} catch {
			setError(`${PROVIDER_LABEL[providerId]} access could not be connected.`);
		} finally {
			setBusyProvider(null);
		}
	};

	const disconnect = async (providerId: AccountAccessProvider) => {
		setBusyProvider(providerId);
		setError(null);
		try {
			const environment = await getRpcClient(environmentId);
			await Effect.runPromise(
				environment["accountAccess.disconnect"]({ providerId }),
			);
			setProgress(null);
			await refresh();
		} catch {
			setError(
				`${PROVIDER_LABEL[providerId]} access could not be disconnected.`,
			);
		} finally {
			setBusyProvider(null);
		}
	};

	const selectedLocal =
		pendingProvider === null ? undefined : localByProvider.get(pendingProvider);

	return (
		<section
			aria-labelledby="cloud-account-access-title"
			className="h-[26rem] overflow-y-auto rounded-lg border border-border p-3"
		>
			<div className="flex min-h-14 items-start justify-between gap-3">
				<div>
					<h3 id="cloud-account-access-title" className="font-medium text-sm">
						Bring access from this Mac
					</h3>
					<p className="mt-1 text-muted-foreground text-xs">
						Connect the same accounts with separate, machine-specific
						credentials.
					</p>
				</div>
				<Button
					type="button"
					variant="ghost"
					className="min-h-11"
					onClick={() => void refresh()}
				>
					Refresh
				</Button>
			</div>

			<div className="mt-2 space-y-2" aria-busy={loading}>
				<div className="flex min-h-14 items-center gap-3 rounded-md bg-muted/20 px-3">
					<div className="min-w-0 flex-1">
						<p className="font-medium text-sm">Developer tools</p>
						<p className="text-muted-foreground text-xs">
							Installed and verified
						</p>
					</div>
					<Badge variant="success">Ready</Badge>
				</div>
				{PROVIDERS.map((providerId) => {
					const status = statusByProvider.get(providerId);
					const local = localByProvider.get(providerId);
					const badge = statusBadge(status);
					const connected = status?.state === "connected";
					const busy = busyProvider === providerId;
					return (
						<div
							key={providerId}
							className="flex min-h-16 items-center gap-3 rounded-md border border-border/60 px-3"
						>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<p className="font-medium text-sm">
										{PROVIDER_LABEL[providerId]}
									</p>
									<Badge variant={badge.variant}>{badge.label}</Badge>
								</div>
								<p className="mt-0.5 truncate text-muted-foreground text-xs">
									{progress?.providerId === providerId
										? progress.message
										: (status?.accountLabel ??
											local?.accountLabel ??
											(providerId === "claude"
												? "Secure token transfer"
												: "Browser device authorization"))}
								</p>
							</div>
							{progress?.providerId === providerId &&
							progress.code !== undefined ? (
								<code className="rounded bg-muted px-2 py-1 font-mono text-xs">
									{progress.code}
								</code>
							) : null}
							{connected ? (
								<>
									<Button
										type="button"
										variant="ghost"
										className="min-h-11"
										disabled={busyProvider !== null}
										onClick={() => setPendingProvider(providerId)}
									>
										Re-sync
									</Button>
									<Button
										type="button"
										variant="ghost"
										className="min-h-11"
										disabled={busyProvider !== null}
										onClick={() => void disconnect(providerId)}
									>
										Disconnect
									</Button>
								</>
							) : (
								<Button
									type="button"
									className="min-h-11"
									disabled={
										loading ||
										busyProvider !== null ||
										status?.installed === false
									}
									onClick={() => setPendingProvider(providerId)}
								>
									{busy ? "Connecting…" : "Connect"}
								</Button>
							)}
						</div>
					);
				})}
				<div className="flex min-h-14 items-center gap-3 rounded-md bg-muted/20 px-3">
					<div className="min-w-0 flex-1">
						<p className="font-medium text-sm">Project access</p>
						<p className="text-muted-foreground text-xs">
							{statusByProvider.get("github")?.state === "connected"
								? "Private repositories can be cloned from this machine."
								: "Connect GitHub to clone private repositories."}
						</p>
					</div>
					<Badge
						variant={
							statusByProvider.get("github")?.state === "connected"
								? "success"
								: "outline"
						}
					>
						{statusByProvider.get("github")?.state === "connected"
							? "Ready"
							: "Pending"}
					</Badge>
				</div>
			</div>

			<div className="mt-2 min-h-5" aria-live="polite">
				{error !== null ? (
					<p role="alert" className="text-destructive text-xs">
						{error}
					</p>
				) : null}
			</div>

			<AlertDialog
				open={pendingProvider !== null}
				onOpenChange={(open) => {
					if (!open) setPendingProvider(null);
				}}
			>
				<AlertDialogPopup className="max-w-sm">
					<AlertDialogHeader>
						<AlertDialogTitle>
							Give this machine account access?
						</AlertDialogTitle>
						<AlertDialogDescription>
							{pendingProvider === null
								? ""
								: `${PROVIDER_LABEL[pendingProvider]}${selectedLocal?.accountLabel ? ` (${selectedLocal.accountLabel})` : ""} will be usable by agents and terminals on this cloud machine. No local config directories, SSH private keys, cookies, or environment files are copied.`}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose render={<Button type="button" variant="ghost" />}>
							Cancel
						</AlertDialogClose>
						<Button
							type="button"
							onClick={() => {
								if (pendingProvider !== null) void runSetup(pendingProvider);
							}}
						>
							Continue
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</section>
	);
}
