import {
	type CloudAuthLoginOperation,
	type CloudAuthMethod,
	type CloudAuthProvider,
	type CloudAuthProviderStatus,
	type CloudAuthStatus,
	CloudWorkspaceOpError,
} from "@zuse/contracts";
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
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import {
	Dialog,
	DialogDescription,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "../ui/dialog.tsx";
import { Input } from "../ui/input.tsx";
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
	return (
		<div className="space-y-2.5">
			<InstructionStep number={1} title="Allow device-code login">
				<p>
					In ChatGPT, open <strong>Settings → Security</strong> and enable
					device-code authorization. Managed workspaces may require an admin to
					enable it.
				</p>
				<Button
					className={`mt-1.5 ${COMPACT_AUTH_ACTION}`}
					size="xs"
					variant="settings"
					onClick={() => void openExternal(CODEX_SECURITY_SETTINGS_URL)}
				>
					<ExternalLink aria-hidden />
					Open ChatGPT security settings
				</Button>
			</InstructionStep>
			<InstructionStep number={2} title="Start the login below">
				Zuse runs the official <code>codex login --device-auth</code> flow
				inside your private E2B authentication sandbox.
			</InstructionStep>
			<InstructionStep number={3} title="Approve the one-time code">
				Open the authorization page, sign in to the intended ChatGPT workspace,
				and enter the code shown below. It expires after 15 minutes. Only
				approve a login you started here.
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
		return { label: "Ready", variant: "success" };
	if (status?.state === "authorizing")
		return { label: "Authorizing", variant: "warning" };
	if (status?.state === "expired")
		return { label: "Reconnect", variant: "warning" };
	if (status?.state === "missing-tool")
		return { label: "Tool unavailable", variant: "warning" };
	if (status?.state === "error")
		return { label: "Needs attention", variant: "warning" };
	if (status?.state === "unsupported-for-sandbox")
		return { label: "Unavailable", variant: "warning" };
	return { label: "Not connected", variant: "outline" };
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

const base64Url = (bytes: ArrayBuffer): string => {
	let binary = "";
	for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/gu, "-")
		.replace(/\//gu, "_")
		.replace(/=+$/u, "");
};

const sealSecret = async (
	publicJwk: string,
	secret: string,
): Promise<string> => {
	const key = await crypto.subtle.importKey(
		"jwk",
		JSON.parse(publicJwk) as JsonWebKey,
		{ name: "RSA-OAEP", hash: "SHA-256" },
		false,
		["encrypt"],
	);
	return base64Url(
		await crypto.subtle.encrypt(
			{ name: "RSA-OAEP" },
			key,
			new TextEncoder().encode(secret),
		),
	);
};

export function CloudWorkspaceAuth() {
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
		[status],
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

	const connectedCount = status?.providers.filter(
		(provider) => provider.state === "connected",
	).length;
	const displayedError =
		error ??
		(status?.authorityState === "error"
			? "Cloud authentication cannot reach E2B right now. Retry without affecting your existing chats."
			: null);
	return (
		<>
			<CloudSettingsGroup
				title="Agent authentication"
				description="Connect each agent once. New cloud chats inherit the authentication in your private account image."
				action={
					<span className="text-[11px] text-muted-foreground">
						{loading
							? "Checking…"
							: `${connectedCount ?? 0} of ${PROVIDERS.length} connected`}
					</span>
				}
			>
				{displayedError === null ? null : (
					<CloudSettingsRow
						title="Cloud authentication needs attention"
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
								Try again
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
									? `${providerStatus.method ?? "Provider"} authentication passed a real CLI status check.`
									: providerId === "claude"
										? "Claude Code subscription, Anthropic API key, or custom endpoint."
										: providerId === "codex"
											? "ChatGPT subscription, OpenAI API key, or custom endpoint."
											: providerId === "cursor"
												? "Cursor API key for cloud chat sandboxes."
												: "Grok device login, xAI API key, or custom endpoint."
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
											Disconnect
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
											? "Manage"
											: needsReconnect
												? "Reconnect"
												: "Connect"}
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
					if (!open) {
						setSelectedProvider(null);
						setOperation(null);
						setSecret("");
						setBaseUrl("");
						setModelProvider("");
					}
				}}
			>
				<DialogPopup className="max-w-[400px] border-0 dark:border-0">
					<DialogHeader>
						<DialogTitle>
							{selectedProvider === null
								? "Agent authentication"
								: `Set up ${LABEL[selectedProvider]}`}
						</DialogTitle>
						<DialogDescription>
							{selectedProvider === null
								? "Choose an authentication method."
								: `Connect once for every new ${LABEL[selectedProvider]} cloud sandbox.`}
						</DialogDescription>
					</DialogHeader>
					<DialogPanel className="space-y-4 pt-2">
						{selectedProvider === "cursor" ? null : (
							<div className="grid grid-cols-3 gap-1 rounded-lg bg-muted/65 p-1">
								{(["subscription", "api-key", "custom"] as const).map(
									(authMethod) => {
										return (
											<button
												key={authMethod}
												type="button"
												className={`h-7 rounded-md px-2 font-medium text-[11px] transition-colors ${
													method === authMethod
														? "bg-background text-foreground shadow-xs"
														: "text-muted-foreground hover:text-foreground"
												}`}
												onClick={() => {
													setMethod(authMethod);
													setOperation(null);
												}}
											>
												{authMethod === "subscription"
													? "Subscription"
													: authMethod === "api-key"
														? "API key"
														: "Custom"}
											</button>
										);
									},
								)}
							</div>
						)}

						{method === "subscription" && selectedProvider === "claude" ? (
							<div className="space-y-3">
								<div>
									<p className="font-medium text-xs">Create a setup token</p>
									<p className="mt-1 text-[11px] leading-4 text-muted-foreground">
										Run this official command on a trusted computer, then paste
										the new machine-purpose token below.
									</p>
								</div>
								<div className="flex h-7 items-center gap-2 rounded-md bg-muted/60 px-2">
									<Terminal className="text-muted-foreground" aria-hidden />
									<code className="min-w-0 flex-1 select-all text-xs">
										claude setup-token
									</code>
									<CopyAction
										text="claude setup-token"
										label="Copy command"
										compact
									/>
								</div>
								<Input
									type="password"
									value={secret}
									onChange={(event) => setSecret(event.currentTarget.value)}
									placeholder="Paste setup token"
									autoComplete="off"
								/>
								<Button
									className={`w-full ${COMPACT_AUTH_ACTION}`}
									loading={busy?.startsWith("configure:") === true}
									disabled={secret.trim().length < 8}
									onClick={() => void configure()}
								>
									Save and verify
								</Button>
							</div>
						) : null}

						{method === "subscription" &&
						selectedProvider !== null &&
						selectedProvider !== "claude" &&
						selectedProvider !== "cursor" ? (
							<div className="space-y-3">
								{selectedProvider === "codex" ? (
									<CodexDeviceLoginInstructions />
								) : (
									<div>
										<p className="font-medium text-xs">Device authorization</p>
										<p className="mt-1 text-[11px] leading-4 text-muted-foreground">
											Start the official Grok login, open the authorization
											page, and enter the code shown here.
										</p>
									</div>
								)}
								{operation?.verificationCode === undefined ? null : (
									<div className="flex h-7 items-center gap-2 rounded-md bg-muted/60 px-2">
										<code className="min-w-0 flex-1 select-all font-semibold text-xs tracking-[0.14em]">
											{operation.verificationCode}
										</code>
										<CopyAction
											text={operation.verificationCode}
											label="Copy code"
										/>
									</div>
								)}
								{operation?.state === "authorizing" &&
								operation.verificationCode === undefined ? (
									<div className="flex h-7 items-center gap-2 rounded-md bg-muted/55 px-2 text-[11px] text-muted-foreground">
										<RefreshCw className="animate-spin" aria-hidden />
										Requesting a one-time code from {LABEL[selectedProvider]}…
									</div>
								) : null}
								<div className="flex gap-2">
									{operation?.verificationUrl === undefined ||
									operation.verificationCode === undefined ? null : (
										<Button
											className={`flex-1 ${COMPACT_AUTH_ACTION}`}
											onClick={() =>
												void openExternal(operation.verificationUrl ?? "")
											}
										>
											<ExternalLink aria-hidden />
											Open authorization
										</Button>
									)}
									<Button
										className={`flex-1 ${COMPACT_AUTH_ACTION}`}
										variant={
											operation?.verificationUrl === undefined
												? "default"
												: "settings"
										}
										loading={busy?.startsWith("login:") === true}
										disabled={operation?.state === "authorizing"}
										onClick={() => void startLogin()}
									>
										{operation?.state === "connected"
											? "Authorized"
											: "Start device login"}
									</Button>
								</div>
								{operation?.state === "authorizing" ? (
									<Button
										className={`w-full ${COMPACT_AUTH_ACTION}`}
										variant="ghost"
										onClick={() => {
											void runControlPlane((client) =>
												client["cloud.auth.login.cancel"]({
													operationId: operation.operationId,
												}),
											).then(setOperation);
										}}
									>
										Cancel login
									</Button>
								) : null}
							</div>
						) : null}

						{method === "api-key" ? (
							<div className="space-y-3">
								<div>
									<p className="font-medium text-xs">Provider API key</p>
									<p className="mt-1 text-[11px] leading-4 text-muted-foreground">
										The key is encrypted directly to your private cloud image
										and never returned by API.
									</p>
								</div>
								<Input
									type="password"
									value={secret}
									onChange={(event) => setSecret(event.currentTarget.value)}
									placeholder="Paste API key"
									autoComplete="off"
								/>
								<Button
									className={`w-full ${COMPACT_AUTH_ACTION}`}
									loading={busy?.startsWith("configure:") === true}
									disabled={secret.trim().length < 8}
									onClick={() => void configure()}
								>
									Save and verify
								</Button>
							</div>
						) : null}

						{method === "custom" ? (
							<div className="space-y-3">
								<div>
									<p className="font-medium text-xs">Compatible endpoint</p>
									<p className="mt-1 text-[11px] leading-4 text-muted-foreground">
										Connect an HTTPS endpoint supported by this agent.
									</p>
								</div>
								<Input
									type="url"
									value={baseUrl}
									onChange={(event) => setBaseUrl(event.currentTarget.value)}
									placeholder="https://api.example.com"
								/>
								<Input
									value={modelProvider}
									onChange={(event) =>
										setModelProvider(event.currentTarget.value)
									}
									placeholder="Provider name (optional)"
								/>
								<Input
									type="password"
									value={secret}
									onChange={(event) => setSecret(event.currentTarget.value)}
									placeholder="Provider secret"
									autoComplete="off"
								/>
								<Button
									className={`w-full ${COMPACT_AUTH_ACTION}`}
									loading={busy?.startsWith("configure:") === true}
									disabled={
										secret.trim().length < 8 || baseUrl.trim().length === 0
									}
									onClick={() => void configure()}
								>
									Save and verify
								</Button>
							</div>
						) : null}
					</DialogPanel>
				</DialogPopup>
			</Dialog>
		</>
	);
}
