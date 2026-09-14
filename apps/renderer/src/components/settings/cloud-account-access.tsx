import "@zuse/i18n/english/settings";
import type {
	AccountAccessAuthKind,
	AccountAccessErrorCode,
	AccountAccessProvider,
	AccountAccessProviderStatus,
	AccountAccessTransferEvent,
} from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Effect } from "effect";
import { Copy, ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { copyText, openExternal } from "../../lib/platform-capabilities.ts";
import { runtimeOperationClient } from "../../lib/runtime-operation-client.ts";
import { runStreamOperation } from "../../lib/stream-operation.ts";
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
import { CloudAuthMethodTabs } from "./cloud-auth-method-tabs.tsx";
import { CloudSettingsGroup, CloudSettingsRow } from "./cloud-settings-ui.tsx";

const PROVIDERS = ["claude", "codex", "cursor", "grok"] as const;
const PROVIDER_LABEL: Record<AccountAccessProvider, string> = {
	claude: "Claude Code",
	codex: "Codex",
	cursor: "Cursor",
	grok: "Grok",
};

const SUBSCRIPTION_HELP: Record<AccountAccessProvider, string> = {
	claude:
		"Run `claude setup-token` on your computer, then paste the newly issued setup token below. Zuse never reads your existing Claude credentials.",
	codex: "Authorize this cloud computer with OpenAI's device-code flow.",
	cursor: "Authorize this cloud computer with Cursor's browser login.",
	grok: "Authorize this cloud computer with Grok's device-code flow.",
};

const API_KEY_HELP: Record<AccountAccessProvider, string> = {
	claude: "Use an Anthropic API key for API-billed Claude Code sessions.",
	codex: "Use an OpenAI API key instead of a ChatGPT subscription.",
	cursor: "Use a Cursor user API key for the Cursor agent SDK.",
	grok: "Use an xAI API key for Grok agent sessions.",
};

const ACCOUNT_ACCESS_ERROR_CODES: ReadonlyArray<AccountAccessErrorCode> = [
	"not-allowed",
	"not-signed-in",
	"unsupported-provider",
	"tool-not-installed",
	"login-failed",
	"credential-store-failed",
	"cleanup-failed",
	"invalid-credential",
	"invalid-configuration",
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
	const text = cause instanceof Error ? cause.message : String(cause);
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
	loading: boolean,
): {
	readonly label: string;
	readonly variant: "success" | "warning" | "outline";
} => {
	if (loading && status === undefined)
		return {
			label: uiMessage("settings:cloud_account_access_checking"),
			variant: "outline",
		};
	if (status?.state === "connected")
		return {
			label: uiMessage("settings:cloud_account_access_authorized"),
			variant: "success",
		};
	if (status?.state === "expired")
		return {
			label: uiMessage("settings:cloud_account_access_reconnect"),
			variant: "warning",
		};
	if (status?.state === "missing-tool")
		return {
			label: uiMessage("settings:cloud_account_access_tool_missing"),
			variant: "warning",
		};
	if (status?.state === "error")
		return {
			label: uiMessage("settings:cloud_account_access_needs_attention"),
			variant: "warning",
		};
	return {
		label: uiMessage("settings:cloud_account_access_signed_out"),
		variant: "outline",
	};
};

export function CloudAccountAccess({
	environmentId,
	unavailableReason = "Create and connect the persistent cloud computer before configuring agent authentication.",
}: {
	readonly environmentId?: string;
	readonly unavailableReason?: string;
}) {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	const [statuses, setStatuses] = useState<
		ReadonlyArray<AccountAccessProviderStatus>
	>([]);
	const [loading, setLoading] = useState(environmentId !== undefined);
	const [pendingProvider, setPendingProvider] =
		useState<AccountAccessProvider | null>(null);
	const [method, setMethod] = useState<AccountAccessAuthKind>("subscription");
	const [busyProvider, setBusyProvider] =
		useState<AccountAccessProvider | null>(null);
	const [progress, setProgress] = useState<RowProgress | null>(null);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		if (environmentId === undefined) {
			setStatuses([]);
			setError(null);
			setLoading(false);
			return;
		}
		setLoading(true);
		try {
			const environment = await runtimeOperationClient(environmentId);
			const remote = await Effect.runPromise(
				environment["accountAccess.status"](),
			);
			setStatuses(remote.providers);
			setError(null);
		} catch {
			setError(
				"Agent authorization could not be checked. Reconnect the cloud computer and try again.",
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
		[statuses, uiMessage],
	);
	const missingTools = statuses.filter(
		(status) => status.state === "missing-tool",
	);
	const developerTools =
		environmentId === undefined
			? {
					description: unavailableReason,
					label: uiMessage(
						"settings:cloud_account_access_cloud_computer_required",
					),
				}
			: loading && statuses.length === 0
				? {
						description: uiMessage(
							"settings:cloud_account_access_checking_installed_agent_tools",
						),
						label: uiMessage("settings:cloud_account_access_checking"),
					}
				: missingTools.length > 0
					? {
							description: uiMessage(
								"settings:cloud_account_access_not_installed",
								{
									value1: String(
										missingTools
											.map((status) => PROVIDER_LABEL[status.providerId])
											.join(", "),
									),
									count: missingTools.length,
								},
							),
							label: uiMessage("settings:cloud_account_access_needs_update"),
						}
					: {
							description: uiMessage(
								"settings:cloud_account_access_claude_code_codex_cursor_and_grok_are_available_on_this_computer",
							),
							label: uiMessage("settings:cloud_account_access_ready"),
						};

	const runSubscriptionLogin = async (providerId: AccountAccessProvider) => {
		if (providerId === "claude" || environmentId === undefined) return;
		setBusyProvider(providerId);
		setPendingProvider(null);
		setProgress({ providerId, message: "Waiting for authorization…" });
		setError(null);
		try {
			const environment = await runtimeOperationClient(environmentId);
			await runStreamOperation(
				environment["accountAccess.startLogin"]({ providerId }),
				async (event: AccountAccessTransferEvent) => {
					if (event._tag === "verification") {
						let copied = false;
						if (event.code !== undefined) {
							try {
								await copyText(event.code);
								copied = true;
							} catch {
								// The code stays visible for manual copying.
							}
						}
						setProgress({
							providerId,
							message: copied
								? "Code copied. Finish sign-in in your browser."
								: "Finish sign-in in your browser.",
							...(event.code === undefined ? {} : { code: event.code }),
							url: event.url,
						});
						await openExternal(event.url);
					} else if (event._tag === "done" && !event.ok) {
						throw new Error(event.reason ?? "login-failed");
					}
				},
			).done;
			setProgress({ providerId, message: "Connected." });
			await refresh();
		} catch (cause) {
			const code = stableAccountAccessErrorCode(cause);
			setProgress(null);
			setError(
				`${PROVIDER_LABEL[providerId]} could not be connected${code === null ? "." : ` (${code}).`}`,
			);
		} finally {
			setBusyProvider(null);
		}
	};

	const submitCredential = async (form: HTMLFormElement) => {
		if (pendingProvider === null || environmentId === undefined) return;
		const providerId = pendingProvider;
		const data = new FormData(form);
		const secret = String(data.get("secret") ?? "").trim();
		if (secret.length === 0) {
			setError("Enter the credential before continuing.");
			return;
		}
		setBusyProvider(providerId);
		setError(null);
		try {
			const environment = await runtimeOperationClient(environmentId);
			if (method === "custom") {
				await Effect.runPromise(
					environment["accountAccess.configureCustom"]({
						providerId,
						baseUrl: String(data.get("base-url") ?? ""),
						secret,
						modelProvider:
							String(data.get("model-provider") ?? "").trim() || undefined,
					}),
				);
			} else {
				await Effect.runPromise(
					environment["accountAccess.setCredential"]({
						providerId,
						method,
						secret,
					}),
				);
			}
			form.reset();
			setPendingProvider(null);
			setProgress({ providerId, message: "Connected." });
			await refresh();
		} catch (cause) {
			const code = stableAccountAccessErrorCode(cause);
			setError(
				`The credential could not be saved${code === null ? "." : ` (${code}).`}`,
			);
		} finally {
			setBusyProvider(null);
		}
	};

	const disconnect = async (providerId: AccountAccessProvider) => {
		if (environmentId === undefined) return;
		setBusyProvider(providerId);
		setError(null);
		try {
			const environment = await runtimeOperationClient(environmentId);
			await Effect.runPromise(
				environment["accountAccess.disconnect"]({ providerId }),
			);
			setProgress(null);
			await refresh();
		} catch {
			setError(`${PROVIDER_LABEL[providerId]} could not be disconnected.`);
		} finally {
			setBusyProvider(null);
		}
	};

	return (
		<>
			<CloudSettingsGroup
				title={uiMessage("settings:cloud_account_access_agent_access")}
				description={uiMessage(
					"settings:cloud_account_access_authorize_agents_on_this_cloud_computer_nothing_is_copied_from_this_ma",
				)}
				action={
					<Button
						size="icon-sm"
						variant="ghost"
						aria-label={uiMessage(
							"settings:cloud_account_access_refresh_agent_authorization",
						)}
						loading={loading}
						disabled={environmentId === undefined}
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
					title={uiMessage("settings:cloud_account_access_agent_tools")}
					description={developerTools.description}
					action={
						<Badge
							variant={
								developerTools.label === "Ready"
									? "success"
									: environmentId === undefined
										? "outline"
										: "warning"
							}
						>
							{developerTools.label}
						</Badge>
					}
				/>
				{PROVIDERS.map((providerId) => {
					const status = statusByProvider.get(providerId);
					const badge =
						environmentId === undefined
							? ({ label: "Not available", variant: "outline" } as const)
							: statusBadge(status, loading);
					const connected = status?.state === "connected";
					const busy = busyProvider === providerId;
					const rowProgress =
						progress?.providerId === providerId ? progress : null;
					const description =
						rowProgress?.message ??
						(environmentId === undefined
							? unavailableReason
							: status?.accountLabel) ??
						(status?.authMethod === undefined
							? "Not configured on this cloud computer"
							: `Connected with ${status.authMethod}`);
					return (
						<CloudSettingsRow
							key={providerId}
							title={PROVIDER_LABEL[providerId]}
							description={<span aria-live="polite">{description}</span>}
							action={
								<>
									<Badge variant={badge.variant}>{badge.label}</Badge>
									<Button
										size="xs"
										variant={connected ? "ghost" : "outline"}
										loading={busy}
										disabled={
											environmentId === undefined ||
											loading ||
											busyProvider !== null ||
											status?.installed === false
										}
										onClick={() => {
											setMethod("subscription");
											setPendingProvider(providerId);
										}}
									>
										{connected
											? uiMessage("settings:cloud_account_access_reauthorize")
											: uiMessage("settings:cloud_account_access_set_up")}
									</Button>
									{connected ? (
										<Button
											size="xs"
											variant="ghost"
											disabled={busyProvider !== null}
											onClick={() => void disconnect(providerId)}
										>
											{uiMessage("common:disconnect")}
										</Button>
									) : null}
								</>
							}
						>
							{rowProgress?.code === undefined ? null : (
								<div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/35 px-2.5 py-2">
									<code className="select-all font-semibold text-sm tracking-[0.12em]">
										{rowProgress.code}
									</code>
									<Button
										type="button"
										size="xs"
										variant="outline"
										onClick={() => void copyText(rowProgress.code ?? "")}
									>
										<Copy aria-hidden />
										{uiMessage("settings:cloud_account_access_copy_code")}
									</Button>
									{rowProgress.url === undefined ? null : (
										<Button
											type="button"
											size="xs"
											variant="ghost"
											onClick={() => void openExternal(rowProgress.url ?? "")}
										>
											<ExternalLink aria-hidden />
											{uiMessage(
												"settings:cloud_account_access_open_login_page",
											)}
										</Button>
									)}
								</div>
							)}
						</CloudSettingsRow>
					);
				})}
			</CloudSettingsGroup>

			<Dialog
				open={pendingProvider !== null}
				onOpenChange={(open) => {
					if (!open) setPendingProvider(null);
				}}
			>
				<DialogPopup className="max-w-[420px]">
					<form
						onSubmit={(event) => {
							event.preventDefault();
							if (pendingProvider !== null) {
								if (method === "subscription" && pendingProvider !== "claude") {
									void runSubscriptionLogin(pendingProvider);
								} else {
									void submitCredential(event.currentTarget);
								}
							}
						}}
					>
						<DialogHeader>
							<DialogTitle>
								{uiMessage("settings:cloud_account_access_set_up")}{" "}
								{pendingProvider === null
									? uiMessage("settings:cloud_account_access_agent")
									: PROVIDER_LABEL[pendingProvider]}
							</DialogTitle>
							<DialogDescription>
								{uiMessage(
									"settings:cloud_account_access_the_credential_is_created_for_and_stored_on_this_cloud_computer_existi",
								)}
							</DialogDescription>
						</DialogHeader>
						<DialogPanel
							className="space-y-3 px-4 pb-4 pt-1"
							scrollFade={false}
						>
							<CloudAuthMethodTabs value={method} onValueChange={setMethod} />
							{pendingProvider === null ? null : (
								<p className="text-xs text-muted-foreground">
									{method === "subscription"
										? SUBSCRIPTION_HELP[pendingProvider]
										: method === "api-key"
											? API_KEY_HELP[pendingProvider]
											: uiMessage(
													"settings:cloud_account_access_configure_an_https_compatible_provider_endpoint_and_its_secret_directl",
												)}
								</p>
							)}
							{method === "subscription" && pendingProvider === "claude" ? (
								<div className="space-y-2">
									<div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
										<code className="text-xs">
											{uiMessage(
												"settings:cloud_account_access_claude_setup_token",
											)}
										</code>
										<Button
											type="button"
											size="xs"
											variant="ghost"
											onClick={() => void copyText("claude setup-token")}
										>
											<Copy aria-hidden />
											{uiMessage("settings:cloud_account_access_copy")}
										</Button>
									</div>
									<Input
										name="secret"
										type="password"
										autoComplete="off"
										placeholder={uiMessage(
											"settings:cloud_account_access_sk_ant_oat01",
										)}
										data-1p-ignore
									/>
								</div>
							) : null}
							{method === "api-key" ? (
								<Input
									name="secret"
									type="password"
									autoComplete="off"
									placeholder={uiMessage(
										"settings:cloud_account_access_paste_api_key",
									)}
									data-1p-ignore
								/>
							) : null}
							{method === "custom" ? (
								<div className="space-y-2">
									<Input
										name="base-url"
										type="url"
										placeholder="https://provider.example/v1"
										autoComplete="off"
									/>
									<Input
										name="model-provider"
										placeholder={uiMessage(
											"settings:cloud_account_access_provider_identifier_optional",
										)}
										autoComplete="off"
									/>
									<Input
										name="secret"
										type="password"
										autoComplete="off"
										placeholder={uiMessage(
											"settings:cloud_account_access_provider_secret",
										)}
										data-1p-ignore
									/>
								</div>
							) : null}
						</DialogPanel>
						<DialogFooter>
							<Button
								type="button"
								size="xs"
								variant="ghost"
								onClick={() => setPendingProvider(null)}
							>
								{uiMessage("common:cancel")}
							</Button>
							<Button
								type="submit"
								size="xs"
								loading={
									pendingProvider !== null && busyProvider === pendingProvider
								}
							>
								{method === "subscription" && pendingProvider !== "claude"
									? uiMessage(
											"settings:cloud_account_access_start_browser_login",
										)
									: uiMessage("settings:cloud_account_access_save_on_computer")}
							</Button>
						</DialogFooter>
					</form>
				</DialogPopup>
			</Dialog>
		</>
	);
}
