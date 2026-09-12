import "@zuse/i18n/english/settings";
import {
	type CloudAuthLoginOperation,
	type CloudAuthMethod,
	type CloudAuthProvider,
	type CloudAuthProviderStatus,
	type CloudAuthStatus,
	CloudWorkspaceOpError,
} from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
import { RichMessage, useMessages as useUiMessages } from "@zuse/i18n/react";
import { sealCloudAuthSecret as sealSecret } from "@zuse/utils/cloud-auth-crypto";
import {
	Check,
	ChevronRight,
	Copy,
	ExternalLink,
	RefreshCw,
	Terminal,
} from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { runControlPlane } from "../../lib/control-plane-client.ts";
import { copyText, openExternal } from "../../lib/platform-capabilities.ts";
import { ProviderIcon } from "../provider-icons.tsx";
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
import { CloudAuthMethodTabs } from "./cloud-auth-method-tabs.tsx";
import {
	CloudSettingsGroup,
	CloudSettingsRow,
	COMPACT_CLOUD_ACTION,
} from "./cloud-settings-ui.tsx";

const PROVIDERS = ["claude", "codex", "cursor", "grok"] as const;
const LABEL: Record<CloudAuthProvider, string> = {
	claude: "Claude Code",
	codex: "Codex",
	cursor: "Cursor",
	grok: "Grok",
};
const CODEX_SECURITY_SETTINGS_URL = "https://chatgpt.com/#settings/Security";
const COMPACT_AUTH_ACTION = COMPACT_CLOUD_ACTION;

function InstructionStep({
	number,
	title,
	children,
}: {
	readonly number: number;
	readonly title: string;
	readonly children: ReactNode;
}) {
	return (
		<div className="flex gap-2.5">
			<span className="grid size-4.5 shrink-0 place-items-center rounded-full bg-muted font-semibold text-[10px] text-muted-foreground">
				{number}
			</span>
			<div className="min-w-0 flex-1">
				<p className="font-medium text-xs">{title}</p>
				<div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
					{children}
				</div>
			</div>
		</div>
	);
}

export function CodexDeviceLoginInstructions() {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	return (
		<div className="space-y-2.5">
			<InstructionStep
				number={1}
				title={uiMessage(
					"settings:cloud_workspace_auth_allow_device_code_login",
				)}
			>
				<p>
					<RichMessage
						id="settings:cloud_workspace_auth_in_chatgpt_open_settings_security_and_enable_device_code_aut_sentence"
						components={{ part0: <strong /> }}
					/>
				</p>
				<Button
					className={`mt-1.5 ${COMPACT_AUTH_ACTION}`}
					size="xs"
					variant="settings"
					onClick={() => void openExternal(CODEX_SECURITY_SETTINGS_URL)}
				>
					<ExternalLink aria-hidden />
					{uiMessage(
						"settings:cloud_workspace_auth_open_chatgpt_security_settings",
					)}
				</Button>
			</InstructionStep>
			<InstructionStep
				number={2}
				title={uiMessage("settings:cloud_workspace_auth_start_the_login_below")}
			>
				<RichMessage
					id="settings:cloud_workspace_auth_zuse_runs_the_official_codex_login_device_auth_flow_inside_y_sentence"
					components={{ part0: <code /> }}
					values={{ code0: "codex login --device-auth" }}
				/>
			</InstructionStep>
			<InstructionStep
				number={3}
				title={uiMessage(
					"settings:cloud_workspace_auth_approve_the_one_time_code",
				)}
			>
				{uiMessage(
					"settings:cloud_workspace_auth_open_the_authorization_page_sign_in_to_the_intended_chatgpt_workspace",
				)}
			</InstructionStep>
		</div>
	);
}

function CopyAction({
	text,
	label,
	compact = false,
}: {
	readonly text: string;
	readonly label: string;
	readonly compact?: boolean;
}) {
	const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
		"idle",
	);

	useEffect(() => {
		if (copyState === "idle") return;
		const timer = window.setTimeout(() => setCopyState("idle"), 1_500);
		return () => window.clearTimeout(timer);
	}, [copyState]);
	const buttonLabel =
		copyState === "copied"
			? "Copied"
			: copyState === "error"
				? "Copy failed"
				: label;

	return (
		<Button
			className={COMPACT_AUTH_ACTION}
			size={compact ? "icon-xs" : "sm"}
			variant="ghost"
			aria-label={buttonLabel}
			onClick={() => {
				void copyText(text).then(
					() => setCopyState("copied"),
					() => setCopyState("error"),
				);
			}}
		>
			{copyState === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
			{compact ? null : buttonLabel}
		</Button>
	);
}

const statusPresentation = (
	status: CloudAuthProviderStatus | undefined,
): {
	readonly label: string;
	readonly variant: "success" | "warning" | "outline";
} => {
	if (status?.state === "connected")
		return {
			label: uiMessage("settings:cloud_workspace_auth_ready"),
			variant: "success",
		};
	if (status?.state === "authorizing")
		return {
			label: uiMessage("settings:cloud_workspace_auth_authorizing"),
			variant: "warning",
		};
	if (status?.state === "expired")
		return {
			label: uiMessage("settings:cloud_workspace_auth_reconnect"),
			variant: "warning",
		};
	if (status?.state === "missing-tool")
		return {
			label: uiMessage("settings:cloud_workspace_auth_tool_unavailable"),
			variant: "warning",
		};
	if (status?.state === "error")
		return {
			label: uiMessage("settings:cloud_workspace_auth_needs_attention"),
			variant: "warning",
		};
	if (status?.state === "unsupported-for-sandbox")
		return {
			label: uiMessage("settings:cloud_workspace_auth_unavailable"),
			variant: "warning",
		};
	return {
		label: uiMessage("settings:cloud_workspace_auth_not_connected"),
		variant: "outline",
	};
};

const authFailureMessage = (cause: unknown, fallback: string): string => {
	if (!(cause instanceof CloudWorkspaceOpError)) return fallback;
	if (cause.code === "entitlement-required")
		return "Cloud Workspace is not active for this account.";
	if (cause.code === "provider-unavailable")
		return "E2B could not start the secure agent setup. Try again in a moment.";
	if (cause.code === "not-allowed")
		return "Your Zuse session could not authorize this action. Refresh your session and try again.";
	return fallback;
};

export function CloudWorkspaceAuth() {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	const [status, setStatus] = useState<CloudAuthStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<string | null>(null);
	const [selectedProvider, setSelectedProvider] =
		useState<CloudAuthProvider | null>(null);
	const [method, setMethod] = useState<CloudAuthMethod>("subscription");
	const [secret, setSecret] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [modelProvider, setModelProvider] = useState("");
	const [operation, setOperation] = useState<CloudAuthLoginOperation | null>(
		null,
	);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			setStatus(
				await runControlPlane((client) => client["cloud.auth.status"]()),
			);
			setError(null);
		} catch (cause) {
			setError(
				authFailureMessage(
					cause,
					"Cloud authentication could not be checked. Your existing chats are unaffected.",
				),
			);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		if (operation?.state !== "authorizing") return;
		const timer = window.setInterval(() => {
			void runControlPlane((client) =>
				client["cloud.auth.login.poll"]({
					operationId: operation.operationId,
				}),
			).then((next) => {
				setOperation(next);
				if (next.state === "connected") void refresh();
			});
		}, 1_000);
		return () => window.clearInterval(timer);
	}, [operation?.operationId, operation?.state, refresh]);

	const statusByProvider = useMemo(
		() => new Map(status?.providers.map((item) => [item.providerId, item])),
		[status, uiMessage],
	);

	const openProviderSetup = async (providerId: CloudAuthProvider) => {
		setBusy(`open:${providerId}`);
		setError(null);
		try {
			if (status?.authorityState !== "ready") {
				setStatus(
					await runControlPlane((client) => client["cloud.auth.provision"]()),
				);
			}
			setSelectedProvider(providerId);
			setMethod(providerId === "cursor" ? "api-key" : "subscription");
			setOperation(null);
		} catch (cause) {
			setError(
				authFailureMessage(
					cause,
					"Agent setup could not be started. Your existing chats are unaffected.",
				),
			);
		} finally {
			setBusy(null);
		}
	};

	const configure = async () => {
		if (
			selectedProvider === null ||
			status?.encryptionKeyId === undefined ||
			status.encryptionPublicJwk === undefined
		)
			return;
		setBusy(`configure:${selectedProvider}`);
		setError(null);
		try {
			const ciphertext = await sealSecret(status.encryptionPublicJwk, secret);
			await runControlPlane((client) =>
				client["cloud.auth.configure"]({
					providerId: selectedProvider,
					method,
					sealedSecret: {
						keyId: status.encryptionKeyId ?? "",
						ciphertext,
					},
					...(method === "custom" && baseUrl.trim().length > 0
						? { baseUrl: baseUrl.trim() }
						: {}),
					...(method === "custom" && modelProvider.trim().length > 0
						? { modelProvider: modelProvider.trim() }
						: {}),
				}),
			);
			setSecret("");
			setSelectedProvider(null);
			await refresh();
		} catch {
			setError(
				"The provider rejected the credential or its real status check failed. The secret was not returned to the app.",
			);
		} finally {
			setBusy(null);
		}
	};

	const startLogin = async () => {
		if (selectedProvider !== "codex" && selectedProvider !== "grok") return;
		setBusy(`login:${selectedProvider}`);
		setError(null);
		try {
			setOperation(
				await runControlPlane((client) =>
					client["cloud.auth.login.start"]({
						providerId: selectedProvider,
					}),
				),
			);
		} catch {
			setError("The official provider login could not be started in E2B.");
		} finally {
			setBusy(null);
		}
	};

	const disconnect = async (providerId: CloudAuthProvider) => {
		setBusy(`disconnect:${providerId}`);
		try {
			await runControlPlane((client) =>
				client["cloud.auth.disconnect"]({ providerId }),
			);
			await refresh();
		} finally {
			setBusy(null);
		}
	};

	const closeProviderSetup = () => {
		setSelectedProvider(null);
		setOperation(null);
		setSecret("");
		setBaseUrl("");
		setModelProvider("");
	};

	const cancelLogin = async () => {
		if (operation?.state !== "authorizing") return;
		setBusy(`cancel:${operation.providerId}`);
		try {
			setOperation(
				await runControlPlane((client) =>
					client["cloud.auth.login.cancel"]({
						operationId: operation.operationId,
					}),
				),
			);
		} finally {
			setBusy(null);
		}
	};

	const connectedCount = status?.providers.filter(
		(provider) => provider.state === "connected",
	).length;
	const displayedError =
		error ??
		(status?.authorityState === "error"
			? "Cloud authentication cannot reach E2B right now. Retry without affecting your existing chats."
			: null);
	const usesDeviceLogin =
		method === "subscription" &&
		selectedProvider !== null &&
		selectedProvider !== "claude" &&
		selectedProvider !== "cursor";
	const canConfigure =
		secret.trim().length >= 8 &&
		(method !== "custom" || baseUrl.trim().length > 0);
	const submitProviderSetup = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (usesDeviceLogin) {
			if (operation?.state !== "authorizing") void startLogin();
			return;
		}
		if (canConfigure) void configure();
	};
	return (
		<>
			<CloudSettingsGroup
				title={uiMessage("settings:cloud_workspace_auth_agent_authentication")}
				description={uiMessage(
					"settings:cloud_workspace_auth_authorize_each_provider_once_account_credentials_are_shared_by_new_clo",
				)}
				action={
					<span className="text-[11px] text-muted-foreground">
						{loading
							? uiMessage("settings:cloud_workspace_auth_checking")
							: uiMessage("settings:cloud_workspace_auth_of_connected", {
									value1: String(connectedCount ?? 0),
									length: String(PROVIDERS.length),
								})}
					</span>
				}
			>
				{displayedError === null ? null : (
					<CloudSettingsRow
						title={uiMessage(
							"settings:cloud_workspace_auth_cloud_authentication_needs_attention",
						)}
						description={displayedError}
						className="bg-destructive/5"
						action={
							<Button
								size="sm"
								variant="outline"
								className={COMPACT_AUTH_ACTION}
								loading={loading}
								onClick={() => {
									setLoading(true);
									void refresh();
								}}
							>
								<RefreshCw aria-hidden />
								{uiMessage("settings:cloud_workspace_auth_try_again")}
							</Button>
						}
					/>
				)}
				{PROVIDERS.map((providerId) => {
					const providerStatus = statusByProvider.get(providerId);
					const presentation = statusPresentation(providerStatus);
					const isConnected = providerStatus?.state === "connected";
					const needsReconnect =
						providerStatus?.state === "expired" ||
						providerStatus?.state === "error";
					return (
						<CloudSettingsRow
							key={providerId}
							title={LABEL[providerId]}
							description={
								providerStatus?.state === "connected"
									? uiMessage(
											"settings:cloud_workspace_auth_shared_account_wide_with_new_cloud_chats_via",
											{
												value1: String(LABEL[providerId]),
												value2: String(
													providerStatus.method ?? "provider authentication",
												),
											},
										)
									: providerId === "claude"
										? uiMessage(
												"settings:cloud_workspace_auth_claude_code_subscription_anthropic_api_key_or_custom_endpoint",
											)
										: providerId === "codex"
											? uiMessage(
													"settings:cloud_workspace_auth_one_account_level_chatgpt_subscription_login_openai_api_key_or_custom",
												)
											: providerId === "cursor"
												? uiMessage(
														"settings:cloud_workspace_auth_cursor_api_key_for_cloud_chat_sandboxes",
													)
												: uiMessage(
														"settings:cloud_workspace_auth_grok_device_login_xai_api_key_or_custom_endpoint",
													)
							}
							action={
								<>
									{providerStatus !== undefined &&
									providerStatus.state !== "disconnected" ? (
										<Badge variant={presentation.variant}>
											{presentation.label}
										</Badge>
									) : null}
									{isConnected ? (
										<Button
											size="xs"
											variant="ghost"
											className={COMPACT_AUTH_ACTION}
											loading={busy === `disconnect:${providerId}`}
											onClick={() => void disconnect(providerId)}
										>
											{uiMessage("common:disconnect")}
										</Button>
									) : null}
									<Button
										size="sm"
										variant="settings"
										className={COMPACT_AUTH_ACTION}
										loading={busy === `open:${providerId}`}
										disabled={loading || busy?.startsWith("open:") === true}
										onClick={() => void openProviderSetup(providerId)}
									>
										{isConnected
											? uiMessage("settings:cloud_workspace_auth_reauthorize")
											: needsReconnect
												? uiMessage("settings:cloud_workspace_auth_reconnect")
												: uiMessage("common:connect")}
										<ChevronRight aria-hidden />
									</Button>
								</>
							}
						/>
					);
				})}
			</CloudSettingsGroup>

			<Dialog
				open={selectedProvider !== null}
				onOpenChange={(open) => {
					if (!open) closeProviderSetup();
				}}
			>
				<DialogPopup className="max-w-[420px]">
					<DialogHeader>
						<div className="flex items-center gap-2">
							{selectedProvider === null ? null : (
								<ProviderIcon
									providerId={selectedProvider}
									className="size-4 shrink-0"
								/>
							)}
							<DialogTitle>
								{selectedProvider === null
									? uiMessage(
											"settings:cloud_workspace_auth_agent_authentication",
										)
									: uiMessage("settings:cloud_workspace_auth_set_up", {
											value1: String(LABEL[selectedProvider]),
										})}
							</DialogTitle>
						</div>
						<DialogDescription>
							{selectedProvider === null
								? uiMessage(
										"settings:cloud_workspace_auth_choose_an_authentication_method",
									)
								: selectedProvider === "codex"
									? uiMessage(
											"settings:cloud_workspace_auth_connect_codex_once_for_your_zuse_account_compatible_cloud_chats_receiv",
										)
									: uiMessage(
											"settings:cloud_workspace_auth_choose_how_new_cloud_sandboxes_authenticate_with",
											{ value1: String(LABEL[selectedProvider]) },
										)}
						</DialogDescription>
					</DialogHeader>
					<form className="contents" onSubmit={submitProviderSetup}>
						<DialogPanel className="space-y-3.5 pb-4 pt-1">
							{selectedProvider === "cursor" ? null : (
								<div className="space-y-1.5">
									<p className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
										{uiMessage(
											"settings:cloud_workspace_auth_authentication_method",
										)}
									</p>
									<CloudAuthMethodTabs
										value={method}
										onValueChange={(authMethod) => {
											setMethod(authMethod);
											setOperation(null);
										}}
									/>
								</div>
							)}

							{method === "subscription" && selectedProvider === "claude" ? (
								<div className="space-y-3 rounded-lg bg-background/55 p-3">
									<div>
										<p className="font-medium text-xs">
											{uiMessage(
												"settings:cloud_workspace_auth_create_a_setup_token",
											)}
										</p>
										<p className="mt-1 text-[11px] leading-4 text-muted-foreground">
											{uiMessage(
												"settings:cloud_workspace_auth_run_this_official_command_on_a_trusted_computer_then_paste_the_new_mac",
											)}
										</p>
									</div>
									<div className="flex h-7 items-center gap-2 rounded-md bg-muted/60 px-2">
										<Terminal className="text-muted-foreground" aria-hidden />
										<code className="min-w-0 flex-1 select-all text-xs">
											{uiMessage(
												"settings:cloud_workspace_auth_claude_setup_token",
											)}
										</code>
										<CopyAction
											text="claude setup-token"
											label={uiMessage(
												"settings:cloud_workspace_auth_copy_command",
											)}
											compact
										/>
									</div>
									<label className="block space-y-1" htmlFor="cloud-auth-token">
										<span className="text-[11px] font-medium">
											{uiMessage("settings:cloud_workspace_auth_setup_token")}
										</span>
										<Input
											id="cloud-auth-token"
											type="password"
											value={secret}
											onChange={(event) => setSecret(event.currentTarget.value)}
											placeholder={uiMessage(
												"settings:cloud_workspace_auth_paste_setup_token",
											)}
											autoComplete="off"
										/>
									</label>
								</div>
							) : null}

							{method === "subscription" &&
							selectedProvider !== null &&
							selectedProvider !== "claude" &&
							selectedProvider !== "cursor" ? (
								<div className="space-y-2.5 rounded-lg bg-background/55 p-3">
									{operation?.state === "connected" ? (
										<div
											role="status"
											className="flex items-center gap-2 rounded-md bg-success/8 px-2.5 py-2 text-[11px] text-foreground"
										>
											<Check
												className="size-3.5 shrink-0 text-success"
												aria-hidden
											/>
											<span className="min-w-0 flex-1">
												{uiMessage(
													"settings:cloud_workspace_auth_is_authorized_and_ready_for_new_cloud_chats_sentence",
													{ value: LABEL[selectedProvider] },
												)}
											</span>
										</div>
									) : null}
									{operation?.state ===
									"connected" ? null : selectedProvider === "codex" ? (
										<CodexDeviceLoginInstructions />
									) : (
										<div>
											<p className="font-medium text-xs">
												{uiMessage(
													"settings:cloud_workspace_auth_device_authorization",
												)}
											</p>
											<p className="mt-1 text-[11px] leading-4 text-muted-foreground">
												{uiMessage(
													"settings:cloud_workspace_auth_start_the_official_grok_login_open_the_authorization_page_and_enter_th",
												)}
											</p>
										</div>
									)}
									{operation?.state === "connected" ||
									operation?.verificationCode === undefined ? null : (
										<div className="flex h-7 items-center gap-2 rounded-md bg-muted/60 px-2">
											<code className="min-w-0 flex-1 select-all font-semibold text-xs tracking-[0.14em]">
												{operation.verificationCode}
											</code>
											<CopyAction
												text={operation.verificationCode}
												label={uiMessage(
													"settings:cloud_workspace_auth_copy_code",
												)}
											/>
										</div>
									)}
									{operation?.state === "authorizing" &&
									operation.verificationCode === undefined ? (
										<div className="flex h-7 items-center gap-2 rounded-md bg-muted/55 px-2 text-[11px] text-muted-foreground">
											<RefreshCw className="animate-spin" aria-hidden />
											{uiMessage(
												"settings:cloud_workspace_auth_requesting_a_one_time_code_from",
											)}
											{LABEL[selectedProvider]}…
										</div>
									) : null}
									{operation?.state === "error" ? (
										<p
											role="alert"
											className="rounded-md bg-destructive/8 px-2.5 py-2 text-[11px] leading-4"
										>
											{uiMessage(
												"settings:cloud_workspace_auth_authorization_did_not_finish_start_a_new_login_and_try_again",
											)}
										</p>
									) : null}
									{operation?.state === "cancelled" ? (
										<p className="rounded-md bg-muted/55 px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
											{uiMessage(
												"settings:cloud_workspace_auth_login_cancelled_no_credentials_were_changed",
											)}
										</p>
									) : null}
								</div>
							) : null}

							{method === "api-key" ? (
								<div className="space-y-3 rounded-lg bg-background/55 p-3">
									<div>
										<p className="font-medium text-xs">
											{uiMessage(
												"settings:cloud_workspace_auth_provider_api_key",
											)}
										</p>
										<p className="mt-1 text-[11px] leading-4 text-muted-foreground">
											{uiMessage(
												"settings:cloud_workspace_auth_the_key_is_encrypted_directly_to_your_private_cloud_image_and_never_re",
											)}
										</p>
									</div>
									<label
										className="block space-y-1"
										htmlFor="cloud-auth-api-key"
									>
										<span className="text-[11px] font-medium">
											{uiMessage("settings:cloud_workspace_auth_api_key")}
										</span>
										<Input
											id="cloud-auth-api-key"
											type="password"
											value={secret}
											onChange={(event) => setSecret(event.currentTarget.value)}
											placeholder={uiMessage(
												"settings:cloud_workspace_auth_paste_api_key",
											)}
											autoComplete="off"
										/>
									</label>
								</div>
							) : null}

							{method === "custom" ? (
								<div className="space-y-3 rounded-lg bg-background/55 p-3">
									<div>
										<p className="font-medium text-xs">
											{uiMessage(
												"settings:cloud_workspace_auth_compatible_endpoint",
											)}
										</p>
										<p className="mt-1 text-[11px] leading-4 text-muted-foreground">
											{uiMessage(
												"settings:cloud_workspace_auth_connect_an_https_endpoint_supported_by_this_agent",
											)}
										</p>
									</div>
									<label
										className="block space-y-1"
										htmlFor="cloud-auth-base-url"
									>
										<span className="text-[11px] font-medium">
											{uiMessage("settings:cloud_workspace_auth_base_url")}
										</span>
										<Input
											id="cloud-auth-base-url"
											type="url"
											value={baseUrl}
											onChange={(event) =>
												setBaseUrl(event.currentTarget.value)
											}
											placeholder="https://api.example.com"
										/>
									</label>
									<label
										className="block space-y-1"
										htmlFor="cloud-auth-provider-name"
									>
										<span className="text-[11px] font-medium">
											<RichMessage
												id="settings:cloud_workspace_auth_provider_nameoptional_sentence"
												components={{
													part0: (
														<span className="ml-1 font-normal text-muted-foreground" />
													),
												}}
											/>
										</span>
										<Input
											id="cloud-auth-provider-name"
											value={modelProvider}
											onChange={(event) =>
												setModelProvider(event.currentTarget.value)
											}
											placeholder={uiMessage(
												"settings:cloud_workspace_auth_provider_identifier",
											)}
										/>
									</label>
									<label
										className="block space-y-1"
										htmlFor="cloud-auth-secret"
									>
										<span className="text-[11px] font-medium">
											{uiMessage(
												"settings:cloud_workspace_auth_provider_secret",
											)}
										</span>
										<Input
											id="cloud-auth-secret"
											type="password"
											value={secret}
											onChange={(event) => setSecret(event.currentTarget.value)}
											placeholder={uiMessage(
												"settings:cloud_workspace_auth_provider_secret",
											)}
											autoComplete="off"
										/>
									</label>
								</div>
							) : null}
						</DialogPanel>
						<DialogFooter>
							<div className="flex w-full items-center justify-end gap-3 sm:justify-between">
								<p className="hidden text-[10px] text-muted-foreground sm:block">
									{uiMessage(
										"settings:cloud_workspace_auth_stored_only_in_your_private_cloud_image",
									)}
								</p>
								<div className="flex items-center justify-end gap-1.5">
									{operation?.state === "authorizing" ? (
										<Button
											type="button"
											className={COMPACT_AUTH_ACTION}
											size="xs"
											variant="ghost"
											onClick={() => void cancelLogin()}
											loading={busy?.startsWith("cancel:") === true}
										>
											{uiMessage("settings:cloud_workspace_auth_cancel_login")}
										</Button>
									) : (
										<DialogClose
											render={
												<Button
													type="button"
													className={COMPACT_AUTH_ACTION}
													size="xs"
													variant="ghost"
												/>
											}
										>
											{uiMessage("common:cancel")}
										</DialogClose>
									)}
									{usesDeviceLogin &&
									operation?.state === "authorizing" &&
									operation.verificationUrl !== undefined &&
									operation.verificationCode !== undefined ? (
										<Button
											type="button"
											className={COMPACT_AUTH_ACTION}
											size="xs"
											onClick={() =>
												void openExternal(operation.verificationUrl ?? "")
											}
										>
											<ExternalLink aria-hidden />
											{uiMessage(
												"settings:cloud_workspace_auth_open_authorization",
											)}
										</Button>
									) : usesDeviceLogin ? (
										<Button
											type="submit"
											className={COMPACT_AUTH_ACTION}
											size="xs"
											loading={busy?.startsWith("login:") === true}
											disabled={operation?.state === "authorizing"}
										>
											{operation?.state === "connected"
												? uiMessage("settings:cloud_workspace_auth_reauthorize")
												: operation?.state === "authorizing"
													? uiMessage(
															"settings:cloud_workspace_auth_requesting_code",
														)
													: operation?.state === "error" ||
															operation?.state === "cancelled"
														? uiMessage(
																"settings:cloud_workspace_auth_try_again",
															)
														: uiMessage(
																"settings:cloud_workspace_auth_start_device_login",
															)}
										</Button>
									) : (
										<Button
											type="submit"
											className={COMPACT_AUTH_ACTION}
											size="xs"
											loading={busy?.startsWith("configure:") === true}
											disabled={!canConfigure}
										>
											{uiMessage(
												"settings:cloud_workspace_auth_save_and_verify",
											)}
										</Button>
									)}
								</div>
							</div>
						</DialogFooter>
					</form>
				</DialogPopup>
			</Dialog>
		</>
	);
}
