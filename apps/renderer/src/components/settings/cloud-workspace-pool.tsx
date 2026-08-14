import {
	CLOUD_WORKSPACE_OFFER_ID,
	type CloudCredentialConnection,
	type CloudProject,
	type CloudProviderOption,
	type CloudWorkspace,
	CloudWorkspaceOpError,
	type GithubRepoSummary,
	type LocalAccountDescriptor,
} from "@zuse/contracts";
import {
	Check,
	ChevronDown,
	Cloud,
	GitBranch,
	Lock,
	RefreshCw,
	X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../hooks/use-auth.ts";
import { cloudWorkspaceAccessPresentation } from "../../lib/cloud-workspace-access.ts";
import { runControlPlane } from "../../lib/control-plane-client.ts";
import { listEnvironmentGithubRepos } from "../../lib/environment-projects.ts";
import { openExternal } from "../../lib/platform-capabilities.ts";
import { getLocalEnvironmentId } from "../../lib/rpc-client.ts";
import { cn } from "../../lib/utils.ts";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover.tsx";
import { CloudSettingsGroup, CloudSettingsRow } from "./cloud-settings-ui.tsx";

const stateVariant = (
	state: CloudWorkspace["state"],
): "success" | "warning" | "error" | "outline" =>
	state === "ready"
		? "success"
		: state === "failed"
			? "error"
			: state === "paused" || state === "archived"
				? "outline"
				: "warning";

function CredentialRow({
	kind,
	label,
	command,
	credential,
	localAccount,
	busy,
	onConnect,
	onDisconnect,
}: {
	readonly kind: "github" | "claude" | "codex";
	readonly label: string;
	readonly command: string;
	readonly credential: CloudCredentialConnection | undefined;
	readonly localAccount: LocalAccountDescriptor | undefined;
	readonly busy: boolean;
	readonly onConnect: (kind: "github" | "claude" | "codex") => unknown;
	readonly onDisconnect: (kind: "github" | "claude" | "codex") => unknown;
}) {
	const connected = credential?.state === "connected";
	return (
		<CloudSettingsRow
			title={label}
			description={
				connected
					? `${credential.accountLabel ?? "Your account"} is ready in new cloud workspaces.`
					: "Set up the account on this Mac, then transfer it securely to Zuse Cloud."
			}
			action={
				connected ? (
					<>
						<Badge variant="success">Connected</Badge>
						<Button
							size="xs"
							variant="ghost"
							loading={busy}
							onClick={() => void onDisconnect(kind)}
						>
							Disconnect
						</Button>
					</>
				) : (
					<Button
						size="xs"
						loading={busy}
						disabled={!localAccount?.detected}
						onClick={() => void onConnect(kind)}
					>
						Transfer to cloud
					</Button>
				)
			}
		>
			{connected ? null : (
				<div className="grid gap-1.5 rounded-md border border-border/40 bg-muted/25 p-2 sm:grid-cols-2">
					<div className="flex items-center gap-2 text-[11px]">
						<span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px]">
							1
						</span>
						<span>
							Run{" "}
							<code className="rounded bg-muted px-1 py-0.5">{command}</code>
						</span>
					</div>
					<div className="flex items-center gap-2 text-[11px]">
						<span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px]">
							2
						</span>
						<span
							className={localAccount?.detected ? "text-success" : undefined}
						>
							{localAccount?.detected
								? `${localAccount.accountLabel ?? "Account"} found — transfer it.`
								: "Return here after sign-in; Zuse detects it automatically."}
						</span>
					</div>
				</div>
			)}
		</CloudSettingsRow>
	);
}

export function CloudWorkspacePool() {
	const { isLoading: authLoading, isSignedIn, signIn, signingIn } = useAuth();
	const [entitlementSubscribed, setEntitlementSubscribed] = useState(false);
	const [serviceAvailable, setServiceAvailable] = useState(true);
	const [providers, setProviders] = useState<
		ReadonlyArray<CloudProviderOption>
	>([]);
	const [projects, setProjects] = useState<ReadonlyArray<CloudProject>>([]);
	const [workspaces, setWorkspaces] = useState<ReadonlyArray<CloudWorkspace>>(
		[],
	);
	const [credentials, setCredentials] = useState<
		ReadonlyArray<CloudCredentialConnection>
	>([]);
	const [localAccounts, setLocalAccounts] = useState<
		ReadonlyArray<LocalAccountDescriptor>
	>([]);
	const [githubRepos, setGithubRepos] = useState<
		ReadonlyArray<GithubRepoSummary>
	>([]);
	const [githubAuthenticated, setGithubAuthenticated] = useState(false);
	const [reposLoading, setReposLoading] = useState(false);
	const [selectedRepos, setSelectedRepos] = useState<ReadonlyArray<string>>([]);
	const [repoSearch, setRepoSearch] = useState("");
	const [repoPickerOpen, setRepoPickerOpen] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [projectError, setProjectError] = useState<string | null>(null);
	const access = cloudWorkspaceAccessPresentation({
		entitlementSubscribed,
		serviceAvailable,
	});
	const subscribed = access.subscribed;
	const loadGithubRepos = useCallback(async () => {
		setReposLoading(true);
		try {
			const result = await listEnvironmentGithubRepos(
				getLocalEnvironmentId(),
				100,
			);
			setGithubRepos(result.repos);
			setGithubAuthenticated(result.authenticated);
		} catch {
			setGithubRepos([]);
			setGithubAuthenticated(false);
		} finally {
			setReposLoading(false);
		}
	}, []);

	const load = useCallback(async () => {
		if (!isSignedIn) return;
		let loadedSubscribed = false;
		try {
			try {
				const entitlements = await runControlPlane((client) =>
					client["machines.entitlements"](),
				);
				loadedSubscribed =
					loadedSubscribed ||
					entitlements.entitlements.some(
						(item) =>
							item.kind === "cloud-workspace" &&
							(item.status === "active" ||
								item.status === "grace" ||
								(item.status === "ended" &&
									item.paidThrough !== undefined &&
									item.paidThrough > Date.now())),
					);
				setEntitlementSubscribed(loadedSubscribed);
			} catch {
				if (!loadedSubscribed) {
					setError("Your Cloud Workspace subscription could not be verified.");
				}
			}

			const [
				providerResult,
				projectResult,
				workspaceResult,
				credentialResult,
				localAccountResult,
			] = await Promise.allSettled([
				runControlPlane((client) => client["cloud.providers"]()),
				runControlPlane((client) => client["cloud.projects.list"]()),
				runControlPlane((client) => client["cloud.workspaces.list"]({})),
				runControlPlane((client) => client["cloud.credentials.list"]()),
				runControlPlane((client) => client["accountAccess.detectLocal"]()),
			]);
			const relayResults = [
				providerResult,
				projectResult,
				workspaceResult,
				credentialResult,
			] as const;
			const relayAvailable = relayResults.some(
				(result) => result.status === "fulfilled",
			);
			setServiceAvailable(relayAvailable);
			if (providerResult.status === "fulfilled") {
				setProviders(providerResult.value.providers);
			}
			if (projectResult.status === "fulfilled")
				setProjects(projectResult.value.projects);
			if (workspaceResult.status === "fulfilled")
				setWorkspaces(workspaceResult.value.workspaces);
			if (credentialResult.status === "fulfilled")
				setCredentials(credentialResult.value.credentials);
			if (localAccountResult.status === "fulfilled")
				setLocalAccounts(localAccountResult.value.accounts);
			setError(
				relayResults.every((result) => result.status === "fulfilled")
					? null
					: relayAvailable
						? "Some cloud workspace data could not be refreshed. Connected accounts remain available."
						: cloudWorkspaceAccessPresentation({
								entitlementSubscribed: loadedSubscribed,
								serviceAvailable: false,
							}).serviceError,
			);
		} catch {
			setServiceAvailable(false);
			setError(
				cloudWorkspaceAccessPresentation({
					entitlementSubscribed: loadedSubscribed,
					serviceAvailable: false,
				}).serviceError,
			);
		}
	}, [isSignedIn]);

	useEffect(() => {
		if (authLoading || !isSignedIn) return;
		void load();
		void loadGithubRepos();
		const timer = window.setInterval(() => void load(), 5_000);
		return () => window.clearInterval(timer);
	}, [authLoading, isSignedIn, load, loadGithubRepos]);

	const run = async (
		name: string,
		operation: () => Promise<unknown>,
		onError?: (message: string) => void,
	) => {
		if (busy !== null) return;
		setBusy(name);
		setError(null);
		try {
			await operation();
			await load();
		} catch (cause) {
			const message =
				cause instanceof CloudWorkspaceOpError &&
				cause.code === "entitlement-required"
					? "A Cloud Workspace subscription is required."
					: name === "connect" &&
							cause instanceof CloudWorkspaceOpError &&
							cause.code === "invalid-request"
						? "One of these repositories could not be connected. Refresh GitHub and try again."
						: name.startsWith("credential:") &&
								cause instanceof CloudWorkspaceOpError &&
								cause.code === "invalid-request"
							? "No signed-in local account could be imported. Sign in on this Mac and try again."
							: "That cloud action could not be completed. Try again.";
			if (onError === undefined) setError(message);
			else onError(message);
		} finally {
			setBusy(null);
		}
	};

	const checkout = () =>
		run("checkout", async () => {
			const result = await runControlPlane((client) =>
				client["machines.checkout"]({ offerId: CLOUD_WORKSPACE_OFFER_ID }),
			);
			await openExternal(result.checkoutUrl);
		});

	const connectProjects = () => {
		setProjectError(null);
		return run(
			"connect",
			async () => {
				const chosen = githubRepos.filter((repo) =>
					selectedRepos.includes(repo.nameWithOwner),
				);
				const connected = await Promise.all(
					chosen.map((repo) =>
						runControlPlane((client) =>
							client["cloud.projects.connect"]({
								repositoryUrl: repo.httpsUrl,
								defaultBranch: repo.defaultBranch,
								visibility: repo.isPrivate ? "private" : "public",
								displayName: repo.nameWithOwner,
								idempotencyKey: crypto.randomUUID(),
							}),
						),
					),
				);
				setProjects((current) => {
					const ids = new Set(connected.map((project) => project.projectId));
					return [
						...current.filter((project) => !ids.has(project.projectId)),
						...connected,
					];
				});
				setSelectedRepos([]);
			},
			setProjectError,
		);
	};

	const connectCredential = (kind: "github" | "claude" | "codex") =>
		run(`credential:${kind}`, async () => {
			const connected = await runControlPlane((client) =>
				client["cloud.credentials.importLocal"]({ kind }),
			);
			setCredentials((current) => [
				...current.filter((item) => item.kind !== kind),
				connected,
			]);
		});

	const disconnectCredential = (kind: "github" | "claude" | "codex") =>
		run(`credential:${kind}`, async () => {
			const disconnected = await runControlPlane((client) =>
				client["cloud.credentials.disconnect"]({ kind }),
			);
			setCredentials((current) => [
				...current.filter((item) => item.kind !== kind),
				disconnected,
			]);
		});

	if (authLoading) return null;
	if (!isSignedIn) {
		return (
			<CloudSettingsGroup
				title="Cloud Workspace · Beta"
				description="Your saved chats remain available on this device. Sign in again to access cloud compute and billing."
			>
				<CloudSettingsRow
					title="Session expired"
					description="Your account session could not be renewed. You do not need to sign out first."
					action={
						<Button size="xs" loading={signingIn} onClick={() => void signIn()}>
							Sign in
						</Button>
					}
				/>
			</CloudSettingsGroup>
		);
	}
	const credentialFor = (kind: "github" | "claude" | "codex") =>
		credentials.find((item) => item.kind === kind);
	const githubConnected = credentialFor("github")?.state === "connected";
	const connectedIdentities = new Set(
		projects.map((project) =>
			project.repositoryIdentity.replace(/^github\.com\//u, "").toLowerCase(),
		),
	);
	const availableRepos = githubRepos.filter(
		(repo) => !connectedIdentities.has(repo.nameWithOwner.toLowerCase()),
	);
	const filteredRepos = availableRepos.filter((repo) => {
		const query = repoSearch.trim().toLowerCase();
		return (
			query.length === 0 ||
			repo.nameWithOwner.toLowerCase().includes(query) ||
			repo.description?.toLowerCase().includes(query) === true
		);
	});
	const agentsConnected = (["claude", "codex"] as const).filter(
		(kind) => credentialFor(kind)?.state === "connected",
	).length;
	const setupSteps = [
		{ label: "Cloud access", complete: subscribed && serviceAvailable },
		{ label: "GitHub", complete: githubConnected },
		{ label: "Repositories", complete: projects.length > 0 },
		{ label: "Agents", complete: agentsConnected > 0 },
	] as const;

	return (
		<>
			{error === null ? null : (
				<div
					role="alert"
					className="rounded-md bg-alert-error-bg px-3 py-2 text-[11px] text-destructive-foreground ring-1 ring-inset ring-destructive/10"
				>
					{error}
				</div>
			)}
			<div className="grid grid-cols-4 gap-1 rounded-lg border border-border/50 bg-muted/20 p-1.5">
				{setupSteps.map((step, index) => (
					<div
						key={step.label}
						className={cn(
							"flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-[10px]",
							step.complete ? "text-foreground" : "text-muted-foreground",
						)}
					>
						<span
							className={cn(
								"flex size-4 shrink-0 items-center justify-center rounded-full border text-[9px]",
								step.complete &&
									"border-success/40 bg-alert-success-bg text-success",
							)}
						>
							{step.complete ? <Check className="size-2.5" /> : index + 1}
						</span>
						<span className="truncate">{step.label}</span>
					</div>
				))}
			</div>

			<CloudSettingsGroup
				title="1 · Cloud access"
				description="Cloud workspaces keep agents running when this app or your laptop is offline."
				action={
					<Badge
						variant={
							subscribed
								? serviceAvailable
									? "success"
									: "warning"
								: "outline"
						}
					>
						{subscribed
							? serviceAvailable
								? "Ready"
								: "Update required"
							: "$20 / month"}
					</Badge>
				}
			>
				<CloudSettingsRow
					title={
						subscribed ? "Cloud workspace is ready" : "Enable Cloud Workspace"
					}
					description={
						subscribed
							? "Each chat gets an isolated workspace. Compute pauses when it is not needed."
							: "Subscribe once, then connect GitHub and the coding agents you already use."
					}
					action={
						subscribed ? (
							<Cloud className="size-4 text-success" aria-hidden />
						) : (
							<Button
								size="xs"
								loading={busy === "checkout"}
								onClick={() => void checkout()}
							>
								Subscribe
							</Button>
						)
					}
				/>
			</CloudSettingsGroup>

			{subscribed && serviceAvailable ? (
				<CloudSettingsGroup
					title="2 · Connect GitHub"
					description="Use your existing GitHub CLI login; no repository URLs or access tokens to paste."
				>
					<CredentialRow
						kind="github"
						label="GitHub"
						command="gh auth login"
						credential={credentialFor("github")}
						localAccount={localAccounts.find(
							(account) => account.providerId === "github",
						)}
						busy={busy === "credential:github"}
						onConnect={connectCredential}
						onDisconnect={disconnectCredential}
					/>
				</CloudSettingsGroup>
			) : null}

			{subscribed && serviceAvailable ? (
				<CloudSettingsGroup
					title="3 · Choose repositories"
					description="Pick from GitHub. Zuse uses each repository's visibility and default branch automatically."
				>
					<CloudSettingsRow
						title="Repositories available to cloud chats"
						description={
							githubAuthenticated
								? "Select one or more repositories, then connect them together."
								: "Run gh auth login on this Mac, then refresh."
						}
					>
						<div className="flex items-center gap-2">
							<Popover open={repoPickerOpen} onOpenChange={setRepoPickerOpen}>
								<PopoverTrigger
									disabled={!githubConnected || !githubAuthenticated}
									className="flex h-8 min-w-52 flex-1 items-center justify-between rounded-md border border-border/50 bg-muted/40 px-2.5 text-xs text-foreground outline-none hover:bg-muted/70 disabled:opacity-50"
								>
									<span>
										{reposLoading
											? "Loading repositories…"
											: selectedRepos.length === 0
												? "Select repositories"
												: `${selectedRepos.length} selected`}
									</span>
									<ChevronDown className="size-3.5 text-muted-foreground" />
								</PopoverTrigger>
								<PopoverPopup
									align="start"
									className="w-96 p-1 [&_[data-slot=popover-viewport]]:p-0"
								>
									<div className="border-border/40 border-b p-2">
										<Input
											value={repoSearch}
											onChange={(event) =>
												setRepoSearch(event.currentTarget.value)
											}
											placeholder="Search your repositories"
											autoFocus
										/>
									</div>
									<div className="max-h-64 overflow-y-auto p-1">
										{filteredRepos.length === 0 ? (
											<p className="px-2 py-6 text-center text-[11px] text-muted-foreground">
												No unconnected repositories found.
											</p>
										) : (
											filteredRepos.map((repo) => {
												const selected = selectedRepos.includes(
													repo.nameWithOwner,
												);
												return (
													<button
														key={repo.nameWithOwner}
														type="button"
														className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/60"
														onClick={() =>
															setSelectedRepos((current) =>
																selected
																	? current.filter(
																			(name) => name !== repo.nameWithOwner,
																		)
																	: [...current, repo.nameWithOwner],
															)
														}
													>
														<GitBranch className="size-3.5 shrink-0" />
														<span className="min-w-0 flex-1 truncate text-xs">
															{repo.nameWithOwner}
														</span>
														{repo.isPrivate ? (
															<Lock className="size-3 text-muted-foreground" />
														) : null}
														{selected ? (
															<Check className="size-3.5 text-success" />
														) : null}
													</button>
												);
											})
										)}
									</div>
								</PopoverPopup>
							</Popover>
							<Button
								size="icon-lg"
								variant="ghost"
								aria-label="Refresh GitHub repositories"
								loading={reposLoading}
								onClick={() => void loadGithubRepos()}
							>
								<RefreshCw aria-hidden />
							</Button>
							<Button
								size="sm"
								loading={busy === "connect"}
								disabled={selectedRepos.length === 0}
								onClick={() => void connectProjects()}
							>
								Connect
							</Button>
						</div>
						{selectedRepos.length === 0 ? null : (
							<div className="flex flex-wrap gap-1.5">
								{selectedRepos.map((name) => (
									<Badge key={name} variant="outline" size="lg">
										<GitBranch aria-hidden />
										{name}
										<button
											type="button"
											aria-label={`Remove ${name}`}
											onClick={() =>
												setSelectedRepos((current) =>
													current.filter((item) => item !== name),
												)
											}
										>
											<X className="size-3" />
										</button>
									</Badge>
								))}
							</div>
						)}
						{projects.length === 0 ? null : (
							<div className="flex flex-wrap gap-1.5 border-border/40 border-t pt-2">
								{projects.map((project) => (
									<Badge key={project.projectId} variant="success" size="lg">
										<Check aria-hidden />
										{project.displayName}
									</Badge>
								))}
							</div>
						)}
					</CloudSettingsRow>
					{projectError === null ? null : (
						<p role="alert" className="px-3 pb-3 text-xs text-destructive">
							{projectError}
						</p>
					)}
				</CloudSettingsGroup>
			) : null}

			{subscribed && serviceAvailable ? (
				<CloudSettingsGroup
					title="4 · Connect your agents"
					description="Prepare the provider locally, then transfer only its credential to cloud workspaces."
				>
					<CredentialRow
						kind="claude"
						label="Claude Code"
						command="claude auth login"
						credential={credentialFor("claude")}
						localAccount={localAccounts.find(
							(account) => account.providerId === "claude",
						)}
						busy={busy === "credential:claude"}
						onConnect={connectCredential}
						onDisconnect={disconnectCredential}
					/>
					<CredentialRow
						kind="codex"
						label="Codex"
						command="codex login"
						credential={credentialFor("codex")}
						localAccount={localAccounts.find(
							(account) => account.providerId === "codex",
						)}
						busy={busy === "credential:codex"}
						onConnect={connectCredential}
						onDisconnect={disconnectCredential}
					/>
				</CloudSettingsGroup>
			) : null}

			{subscribed && serviceAvailable && workspaces.length > 0 ? (
				<details className="group rounded-lg border border-border/40 bg-muted/10">
					<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
						<ChevronDown className="size-3 transition-transform group-open:rotate-180" />
						Workspace activity
						<Badge variant="outline">{workspaces.length}</Badge>
					</summary>
					<div className="divide-y divide-border/40 border-border/40 border-t">
						{workspaces.map((workspace) => (
							<CloudSettingsRow
								key={workspace.workspaceId}
								title={workspace.branch}
								description={`${providers.find((provider) => provider.providerId === workspace.providerId)?.displayName ?? workspace.providerId} · ${workspace.statusCode}`}
								action={
									<Badge variant={stateVariant(workspace.state)}>
										{workspace.state}
									</Badge>
								}
							/>
						))}
					</div>
				</details>
			) : null}
		</>
	);
}
