import type {
	AccountAccessProvider,
	AccountAccessProviderStatus,
	AccountAccessSealedCredential,
	AccountAccessTransferEvent,
	LocalAccountDescriptor,
} from "@zuse/contracts";
import { Effect, Stream } from "effect";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "../ui/dialog.tsx";
import { Input } from "../ui/input.tsx";
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
	const [claudeTransferId, setClaudeTransferId] = useState<string | null>(null);
	const [claudeCodeError, setClaudeCodeError] = useState<string | null>(null);
	const [submittingClaudeCode, setSubmittingClaudeCode] = useState(false);
	const claudeLoginCancelled = useRef(false);

	const refresh = useCallback(async () => {
		setLoading(true);
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
			setError(
				"Account access could not be checked. Update or reconnect the machine, then try again.",
			);
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
	const missingTools = statuses.filter(
		(status) => status.state === "missing-tool",
	);
	const developerTools =
		loading && statuses.length === 0
			? {
					description: "Checking installed developer tools.",
					label: "Checking",
					variant: "outline" as const,
				}
			: statuses.length !== PROVIDERS.length
				? {
						description: "Installed developer tools could not be verified.",
						label: "Unavailable",
						variant: "warning" as const,
					}
				: missingTools.length > 0
					? {
							description: `${missingTools.map((status) => PROVIDER_LABEL[status.providerId]).join(", ")} ${missingTools.length === 1 ? "is" : "are"} not installed.`,
							label: "Needs update",
							variant: "warning" as const,
						}
					: {
							description:
								"Git, GitHub CLI, Bun, Node, Claude Code, and Codex are installed.",
							label: "Ready",
							variant: "success" as const,
						};

	const runSetup = async (providerId: AccountAccessProvider) => {
		setPendingProvider(null);
		setBusyProvider(providerId);
		setProgress({ providerId, message: "Waiting for authorization…" });
		setError(null);
		claudeLoginCancelled.current = false;
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
									setClaudeTransferId(prepared.transferId);
									setClaudeCodeError(null);
									setProgress({
										providerId,
										message:
											"Finish authorization, then paste the one-time code.",
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
			setClaudeTransferId(null);
			await refresh();
		} catch {
			if (!claudeLoginCancelled.current) {
				setError(
					`${PROVIDER_LABEL[providerId]} access could not be connected.`,
				);
			}
		} finally {
			setClaudeTransferId(null);
			setBusyProvider(null);
		}
	};

	const continueClaudeTransfer = async (form: HTMLFormElement) => {
		if (claudeTransferId === null) return;
		const code = new FormData(form).get("claude-authorization-code");
		if (typeof code !== "string" || code.trim().length === 0) {
			setClaudeCodeError("Paste the one-time code from Claude.");
			return;
		}
		setSubmittingClaudeCode(true);
		setClaudeCodeError(null);
		try {
			const control = await getControlPlaneRpcClient();
			await Effect.runPromise(
				control["accountAccess.continueClaudeTransfer"]({
					_tag: "code",
					transferId: claudeTransferId,
					code,
				}),
			);
			form.reset();
			setClaudeTransferId(null);
			setProgress({
				providerId: "claude",
				message: "Checking authorization…",
			});
		} catch {
			setClaudeCodeError("The code could not be submitted. Try again.");
		} finally {
			setSubmittingClaudeCode(false);
		}
	};

	const cancelClaudeTransfer = async () => {
		if (claudeTransferId === null) return;
		const transferId = claudeTransferId;
		claudeLoginCancelled.current = true;
		setClaudeTransferId(null);
		setClaudeCodeError(null);
		setProgress(null);
		try {
			const control = await getControlPlaneRpcClient();
			await Effect.runPromise(
				control["accountAccess.continueClaudeTransfer"]({
					_tag: "cancel",
					transferId,
				}),
			);
		} catch {
			setError("Claude login could not be cancelled cleanly.");
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
					description={developerTools.description}
					action={
						<Badge variant={developerTools.variant}>
							{developerTools.label}
						</Badge>
					}
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

			<Dialog
				open={claudeTransferId !== null}
				onOpenChange={(open) => {
					if (!open) void cancelClaudeTransfer();
				}}
			>
				<DialogPopup className="max-w-sm" showCloseButton={false}>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void continueClaudeTransfer(event.currentTarget);
						}}
					>
						<DialogHeader>
							<DialogTitle>Finish Claude authorization</DialogTitle>
							<DialogDescription>
								After signing in, copy the one-time code shown by Claude and
								paste it here. It is sent only to the local login process.
							</DialogDescription>
						</DialogHeader>
						<DialogPanel className="space-y-2">
							<label
								className="block space-y-1"
								htmlFor="claude-authorization-code"
							>
								<span className="text-[11px] font-medium">One-time code</span>
								<Input
									id="claude-authorization-code"
									name="claude-authorization-code"
									type="password"
									autoComplete="off"
									spellCheck={false}
									data-1p-ignore
									autoFocus
									aria-invalid={claudeCodeError !== null}
									aria-describedby={
										claudeCodeError === null
											? undefined
											: "claude-authorization-code-error"
									}
								/>
							</label>
							{claudeCodeError === null ? null : (
								<p
									id="claude-authorization-code-error"
									role="alert"
									className="text-[11px] text-destructive"
								>
									{claudeCodeError}
								</p>
							)}
						</DialogPanel>
						<DialogFooter>
							<Button
								type="button"
								size="xs"
								variant="ghost"
								disabled={submittingClaudeCode}
								onClick={() => void cancelClaudeTransfer()}
							>
								Cancel login
							</Button>
							<Button type="submit" size="xs" loading={submittingClaudeCode}>
								Continue
							</Button>
						</DialogFooter>
					</form>
				</DialogPopup>
			</Dialog>
		</>
	);
}
