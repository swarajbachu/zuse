import {
	AccountAccessCreateClaudeTransferRequest,
	type AccountAccessErrorCode,
	AccountAccessImportRequest,
	type AccountAccessProvider,
	type AccountAccessProviderStatus,
	type AccountAccessSealedCredential,
	type AccountAccessStatus,
	type AccountAccessTransferEvent,
	type LocalAccountDescriptor,
} from "@zuse/contracts";
import { Effect, Stream } from "effect";
import { Copy, ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyText, openExternal } from "../../lib/platform-capabilities.ts";
import {
	getControlPlaneRpcClient,
	getRpcClient,
	getVerifiedRpcClient,
	reportRendererRpcFailure,
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

export const hasConnectedClaudeAccess = (
	status: AccountAccessStatus,
): boolean =>
	status.providers.some(
		(provider) =>
			provider.providerId === "claude" && provider.state === "connected",
	);

const ACCOUNT_ACCESS_ERROR_CODES: ReadonlyArray<AccountAccessErrorCode> = [
	"not-allowed",
	"not-signed-in",
	"unsupported-provider",
	"tool-not-installed",
	"login-failed",
	"transfer-expired",
	"transfer-replayed",
	"transfer-rejected",
	"credential-store-failed",
	"cleanup-failed",
];

const stableAccountAccessErrorCode = (
	cause: unknown,
): AccountAccessErrorCode | null => {
	if (typeof cause === "object" && cause !== null && "code" in cause) {
		const code = cause.code;
		if (
			typeof code === "string" &&
			ACCOUNT_ACCESS_ERROR_CODES.includes(code as AccountAccessErrorCode)
		) {
			return code as AccountAccessErrorCode;
		}
	}
	const text = typeof cause === "string" ? cause : "";
	return (
		ACCOUNT_ACCESS_ERROR_CODES.find((candidate) => text.includes(candidate)) ??
		null
	);
};

type RowProgress = {
	readonly providerId: AccountAccessProvider;
	readonly message: string;
	readonly code?: string;
	readonly url?: string;
};

const statusBadge = (
	status: AccountAccessProviderStatus | undefined,
	available: boolean,
	loading: boolean,
): {
	readonly label: string;
	readonly variant: "success" | "warning" | "outline";
} => {
	if (!available) {
		return loading
			? { label: "Checking", variant: "outline" }
			: { label: "Unavailable", variant: "warning" };
	}
	if (status?.state === "connected")
		return { label: "Authorized", variant: "success" };
	if (status?.state === "missing-tool")
		return { label: "Tool missing", variant: "warning" };
	return { label: "Signed out", variant: "outline" };
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
	const [claudeCodeReady, setClaudeCodeReady] = useState(false);
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
	const accountAccessAvailable = statuses.length === PROVIDERS.length;
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
		let claudePhase: "authorization" | "remote-import" = "authorization";
		setClaudeCodeReady(false);
		setSubmittingClaudeCode(false);
		if (!accountAccessAvailable) {
			setError(
				"Account setup is unavailable on this machine runtime. Finish the update, then refresh.",
			);
			return;
		}
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
				// The Claude CLI may open the browser itself and render its manual-code
				// prompt without a newline. Keep the destination visible from the moment
				// the interactive process starts instead of making the dialog depend on
				// parsing a verification URL from terminal output.
				setClaudeTransferId(prepared.transferId);
				setClaudeCodeError(null);
				setProgress({
					providerId,
					message: "Sign in to Claude. The code field will unlock when ready.",
				});
				let sealed: AccountAccessSealedCredential | null = null;
				await Effect.runPromise(
					Stream.runForEach(
						control["accountAccess.createClaudeTransfer"](
							new AccountAccessCreateClaudeTransferRequest({ prepared }),
						),
						(event: AccountAccessTransferEvent) =>
							Effect.promise(async () => {
								if (event._tag === "input-ready") {
									setClaudeCodeReady(true);
									setProgress({
										providerId,
										message: "Paste the one-time code from Claude.",
									});
								} else if (event._tag === "verification") {
									setProgress({
										providerId,
										message:
											"Finish authorization. Waiting for Claude's code prompt…",
										code: event.code,
										url: event.url,
									});
									await openExternal(event.url);
								} else if (event._tag === "sealed") {
									setProgress({
										providerId,
										message: "Saving Claude access on this machine…",
									});
									sealed = event.sealed;
								} else if (event._tag === "done" && !event.ok) {
									throw new Error(event.reason ?? "login-failed");
								}
							}),
					),
				);
				if (sealed === null) throw new Error("transfer-rejected");
				const importRequest = new AccountAccessImportRequest({
					transferId: prepared.transferId,
					sealed,
				});
				claudePhase = "remote-import";
				try {
					const destination = await getVerifiedRpcClient(environmentId);
					await Effect.runPromise(
						destination["accountAccess.import"](importRequest).pipe(
							Effect.timeout("10 seconds"),
						),
					);
				} catch (cause) {
					// The response may be lost after the remote machine stores this
					// single-use transfer. Reconcile status instead of replaying it.
					reportRendererRpcFailure(cause, environmentId);
					const destination = await getVerifiedRpcClient(environmentId);
					const reconciled = await Effect.runPromise(
						destination["accountAccess.status"]().pipe(
							Effect.timeout("10 seconds"),
						),
					);
					if (!hasConnectedClaudeAccess(reconciled)) {
						throw cause;
					}
				}
			} else {
				await Effect.runPromise(
					Stream.runForEach(
						environment["accountAccess.startLogin"]({ providerId }),
						(event: AccountAccessTransferEvent) =>
							Effect.promise(async () => {
								if (event._tag === "verification") {
									let codeCopied = false;
									if (event.code !== undefined) {
										try {
											await copyText(event.code);
											codeCopied = true;
										} catch {
											// The code remains visible in the row for manual copying.
										}
									}
									setProgress({
										providerId,
										message: codeCopied
											? "Code copied. Paste it in your browser."
											: "Enter the code in your browser.",
										code: event.code,
										url: event.url,
									});
									await openExternal(event.url);
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
		} catch (cause) {
			setProgress(null);
			if (!claudeLoginCancelled.current) {
				const code = stableAccountAccessErrorCode(cause);
				const detail =
					providerId === "claude" && claudePhase === "remote-import"
						? "Claude authorized locally, but access could not be saved on the cloud machine. Reconnect and try again."
						: providerId === "claude"
							? "Claude did not finish exchanging the one-time code. Start a fresh login and try again."
							: `${PROVIDER_LABEL[providerId]} access could not be connected.`;
				setError(`${detail}${code === null ? "" : ` (${code})`}`);
			}
		} finally {
			setClaudeTransferId(null);
			setClaudeCodeReady(false);
			setSubmittingClaudeCode(false);
			setBusyProvider(null);
		}
	};

	const continueClaudeTransfer = async (form: HTMLFormElement) => {
		if (claudeTransferId === null) return;
		if (!claudeCodeReady) {
			setClaudeCodeError("Wait until Claude is ready for the code.");
			return;
		}
		const code = new FormData(form).get("claude-authorization-code");
		if (typeof code !== "string" || code.trim().length === 0) {
			setClaudeCodeError("Paste the one-time code from Claude.");
			return;
		}
		setSubmittingClaudeCode(true);
		setClaudeCodeError(null);
		setProgress({
			providerId: "claude",
			message: "Submitting the authorization code…",
		});
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
			setProgress({
				providerId: "claude",
				message: "Exchanging the one-time code securely…",
			});
		} catch {
			setSubmittingClaudeCode(false);
			setClaudeCodeError("The code could not be submitted. Try again.");
		}
	};

	const cancelClaudeTransfer = async () => {
		if (claudeTransferId === null) return;
		const transferId = claudeTransferId;
		claudeLoginCancelled.current = true;
		setClaudeTransferId(null);
		setClaudeCodeError(null);
		setClaudeCodeReady(false);
		setSubmittingClaudeCode(false);
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
				description="Machine connectivity is separate from account authorization. Authorize each developer account you want available remotely."
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
					const badge = statusBadge(status, accountAccessAvailable, loading);
					const connected = status?.state === "connected";
					const busy = busyProvider === providerId;
					const rowProgress =
						progress?.providerId === providerId ? progress : null;
					const description = !accountAccessAvailable
						? loading
							? "Checking whether account setup is available."
							: "Update this machine before configuring account access."
						: rowProgress === null
							? (status?.accountLabel ??
								local?.accountLabel ??
								(providerId === "claude"
									? "Secure token transfer from this Mac"
									: "Authorize this machine in your browser"))
							: rowProgress.message;
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
												!accountAccessAvailable ||
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
						>
							{rowProgress?.code === undefined ? null : (
								<div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/35 px-2.5 py-2">
									<div className="min-w-0 flex-1">
										<p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
											Device code
										</p>
										<code className="mt-0.5 block select-all font-semibold text-sm tracking-[0.12em] text-foreground">
											{rowProgress.code}
										</code>
									</div>
									<Button
										type="button"
										size="xs"
										variant="outline"
										onClick={() => void copyText(rowProgress.code ?? "")}
									>
										<Copy aria-hidden />
										Copy code
									</Button>
									{rowProgress.url === undefined ? null : (
										<Button
											type="button"
											size="xs"
											variant="ghost"
											onClick={() => void openExternal(rowProgress.url ?? "")}
										>
											<ExternalLink aria-hidden />
											Open login page
										</Button>
									)}
								</div>
							)}
						</CloudSettingsRow>
					);
				})}
				<CloudSettingsRow
					title="Private repository access"
					description={
						!accountAccessAvailable
							? "Update this machine before checking repository authorization."
							: statusByProvider.get("github")?.state === "connected"
								? "GitHub CLI can clone, fetch, and push private repositories."
								: "Connect GitHub before opening a private repository."
					}
					action={
						<Badge
							variant={
								!accountAccessAvailable
									? "warning"
									: statusByProvider.get("github")?.state === "connected"
										? "success"
										: "outline"
							}
						>
							{!accountAccessAvailable
								? loading
									? "Checking"
									: "Unavailable"
								: statusByProvider.get("github")?.state === "connected"
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
				<DialogPopup
					className="max-w-sm overflow-hidden"
					showCloseButton={false}
				>
					<form
						className="flex min-h-0 flex-col"
						onSubmit={(event) => {
							event.preventDefault();
							void continueClaudeTransfer(event.currentTarget);
						}}
					>
						<DialogHeader>
							<DialogTitle>Finish Claude authorization</DialogTitle>
							<DialogDescription>
								{submittingClaudeCode
									? "Exchanging the one-time code. This normally takes only a few seconds."
									: claudeCodeReady
										? "Copy the one-time code shown by Claude and paste it here. It is sent only to the local login process."
										: "Complete sign-in in your browser. The code field will unlock when the local Claude process is ready."}
							</DialogDescription>
						</DialogHeader>
						<DialogPanel
							className="space-y-2 px-4 pb-4 pt-1"
							scrollFade={false}
						>
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
									disabled={!claudeCodeReady || submittingClaudeCode}
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
						<DialogFooter className="px-4 py-2">
							<Button
								type="button"
								size="xs"
								variant="ghost"
								onClick={() => void cancelClaudeTransfer()}
							>
								Cancel login
							</Button>
							<Button
								type="submit"
								size="xs"
								disabled={!claudeCodeReady || submittingClaudeCode}
							>
								{submittingClaudeCode
									? "Connecting…"
									: claudeCodeReady
										? "Continue"
										: "Waiting…"}
							</Button>
						</DialogFooter>
					</form>
				</DialogPopup>
			</Dialog>
		</>
	);
}
