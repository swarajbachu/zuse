import type {
	AccountAccessProvider,
	AccountAccessProviderStatus,
	AccountAccessSealedCredential,
	AccountAccessTransferEvent,
	LocalAccountDescriptor,
} from "@zuse/contracts";
import { Effect, Stream } from "effect";
import { RefreshCw } from "lucide-react";
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
import { CloudSettingsGroup, CloudSettingsRow } from "./cloud-settings-ui.tsx";

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
		<>
			<CloudSettingsGroup
				title="Developer access"
				description="Connect separate, machine-specific credentials for the accounts you use on this Mac."
				action={
					<Button
						size="icon-sm"
						variant="ghost"
						aria-label="Refresh developer access"
						loading={loading}
						onClick={() => void refresh()}
					>
						<RefreshCw aria-hidden />
					</Button>
				}
				footer={
					error === null ? null : (
						<p role="alert" className="text-[11px] text-destructive">
							{error}
						</p>
					)
				}
			>
				<CloudSettingsRow
					title="Developer tools"
					description="Git, GitHub CLI, Bun, Node, Claude Code, and Codex are installed."
					action={<Badge variant="success">Ready</Badge>}
				/>
				{PROVIDERS.map((providerId) => {
					const status = statusByProvider.get(providerId);
					const local = localByProvider.get(providerId);
					const badge = statusBadge(status);
					const connected = status?.state === "connected";
					const busy = busyProvider === providerId;
					const rowProgress =
						progress?.providerId === providerId ? progress : null;
					const description =
						rowProgress === null
							? (status?.accountLabel ??
								local?.accountLabel ??
								(providerId === "claude"
									? "Secure token transfer from this Mac"
									: "Authorize this machine in your browser"))
							: `${rowProgress.message}${rowProgress.code === undefined ? "" : ` Code: ${rowProgress.code}`}`;
					return (
						<CloudSettingsRow
							key={providerId}
							title={PROVIDER_LABEL[providerId]}
							description={<span aria-live="polite">{description}</span>}
							action={
								<>
									<Badge variant={badge.variant}>{badge.label}</Badge>
									{connected ? (
										<>
											<Button
												size="xs"
												variant="ghost"
												disabled={busyProvider !== null}
												onClick={() => setPendingProvider(providerId)}
											>
												Re-sync
											</Button>
											<Button
												size="xs"
												variant="ghost"
												disabled={busyProvider !== null}
												onClick={() => void disconnect(providerId)}
											>
												Disconnect
											</Button>
										</>
									) : (
										<Button
											size="xs"
											variant="outline"
											loading={busy}
											disabled={
												loading ||
												busyProvider !== null ||
												status?.installed === false
											}
											onClick={() => setPendingProvider(providerId)}
										>
											Connect
										</Button>
									)}
								</>
							}
						/>
					);
				})}
				<CloudSettingsRow
					title="Private repository access"
					description={
						statusByProvider.get("github")?.state === "connected"
							? "GitHub CLI can clone, fetch, and push private repositories."
							: "Connect GitHub before opening a private repository."
					}
					action={
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
					}
				/>
			</CloudSettingsGroup>

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
								: `${PROVIDER_LABEL[pendingProvider]}${selectedLocal?.accountLabel ? ` (${selectedLocal.accountLabel})` : ""} will be usable by agents and terminals on this cloud machine. Local config folders, SSH private keys, cookies, and environment files stay on this Mac.`}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose render={<Button size="xs" variant="ghost" />}>
							Cancel
						</AlertDialogClose>
						<Button
							size="xs"
							onClick={() => {
								if (pendingProvider !== null) void runSetup(pendingProvider);
							}}
						>
							Continue
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</>
	);
}
