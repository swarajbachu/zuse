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
	ChevronDown,
	Cloud,
	GitBranch,
	Lock,
	RefreshCw,
	X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useAuth } from "../../hooks/use-auth.ts";
import { cloudWorkspaceAccessPresentation } from "../../lib/cloud-workspace-access.ts";
import { runControlPlane } from "../../lib/control-plane-client.ts";
import { listEnvironmentGithubRepos } from "../../lib/environment-projects.ts";
import { openExternal } from "../../lib/platform-capabilities.ts";
import { getLocalEnvironmentId } from "../../lib/rpc-client.ts";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
} from "../ui/select.tsx";
import { CloudSettingsRow } from "./cloud-settings-ui.tsx";

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
			className="px-0"
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
				<ol className="mt-2 grid gap-1.5 text-[11px] sm:grid-cols-2">
					<li className="flex items-center gap-2">
						<span className="text-muted-foreground">1.</span>
						<span>
							Run{" "}
							<code className="rounded bg-muted px-1 py-0.5">{command}</code>
						</span>
					</li>
					<li className="flex items-center gap-2">
						<span className="text-muted-foreground">2.</span>
						<span
							className={localAccount?.detected ? "text-success" : undefined}
						>
							{localAccount?.detected
								? `${localAccount.accountLabel ?? "Account"} found — transfer it.`
								: "Return here after sign-in; Zuse detects it automatically."}
						</span>
					</li>
				</ol>
			)}
		</CloudSettingsRow>
	);
}

function SetupSection({
	title,
	description,
	action,
	children,
}: {
	readonly title: string;
	readonly description: string;
	readonly action?: ReactNode;
	readonly children: ReactNode;
}) {
	return (
		<section className="border-border border-t py-5 first:border-t-0 first:pt-1">
			<div className="flex items-start gap-4">
				<div className="min-w-0 flex-1">
					<h3 className="text-sm font-medium">{title}</h3>
					<p className="mt-1 text-[11px] leading-4 text-muted-foreground">
						{description}
					</p>
				</div>
				{action}
			</div>
			<div className="mt-3">{children}</div>
		</section>
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
								idempotencyKey: `settings-connect:${repo.nameWithOwner}:${repo.defaultBranch}`,
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
	const prepareProject = (project: CloudProject) =>
		run(`build:${project.projectId}`, async () => {
			await Promise.all(
				providers.map((provider) =>
					runControlPlane((client) =>
						client["cloud.projects.prepare"]({
							projectId: project.projectId,
							providerId: provider.providerId,
							idempotencyKey: `settings-build:${project.projectId}:${provider.providerId}:${project.updatedAt}`,
						}),
					),
				),
			);
		});

	if (authLoading) return null;
	if (!isSignedIn) {
		return (
			<SetupSection
				title="Cloud Workspace · Beta"
				description="Your saved chats remain available on this device. Sign in again to access cloud compute and billing."
				action={
					<Button size="xs" loading={signingIn} onClick={() => void signIn()}>
						Sign in
					</Button>
				}
			>
				<p className="text-[11px] text-muted-foreground">
					Your account session expired. You do not need to sign out first.
				</p>
			</SetupSection>
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
	const unfinishedProjects = projects.filter(
		(project) => project.state !== "ready",
	);

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
			<SetupSection
				title="Cloud access"
				description="Cloud workspaces keep agents running when this app or your laptop is offline."
				action={
					subscribed ? (
						<Badge variant={serviceAvailable ? "success" : "warning"}>
							{serviceAvailable ? "Ready" : "Update required"}
						</Badge>
					) : (
						<Button
							size="xs"
							loading={busy === "checkout"}
							onClick={() => void checkout()}
						>
							Subscribe · $20/month
						</Button>
					)
				}
			>
				<p className="flex items-center gap-2 text-[11px] text-muted-foreground">
					<Cloud className="size-3.5" aria-hidden />
					Each chat gets an isolated workspace. Compute pauses when it is not
					needed.
				</p>
			</SetupSection>

			{subscribed && serviceAvailable ? (
				<SetupSection
					title="Connect GitHub"
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
				</SetupSection>
			) : null}

			{subscribed && serviceAvailable ? (
				<SetupSection
					title="Repositories"
					description="Choose repositories from GitHub, then build the cloud images used to start new workspaces."
				>
					<div className="space-y-2.5">
						<p className="text-[11px] text-muted-foreground">
							{githubAuthenticated
								? "Select one or more repositories. Existing agents keep running while new images build."
								: "Run gh auth login on this Mac, then refresh."}
						</p>
						<div className="flex items-center gap-2">
							<Select
								value=""
								disabled={!githubConnected || !githubAuthenticated}
								onValueChange={(value) => {
									if (value !== null && !selectedRepos.includes(value))
										setSelectedRepos((current) => [...current, value]);
								}}
							>
								<SelectTrigger className="min-h-8 flex-1 border-border">
									<span>
										{reposLoading
											? "Loading repositories…"
											: selectedRepos.length === 0
												? "Select repositories"
												: `${selectedRepos.length} selected`}
									</span>
								</SelectTrigger>
								<SelectPopup>
									{availableRepos.map((repo) => (
										<SelectItem
											key={repo.nameWithOwner}
											value={repo.nameWithOwner}
										>
											<GitBranch aria-hidden />
											<span className="flex min-w-0 items-center gap-2">
												<span className="truncate">{repo.nameWithOwner}</span>
												{repo.isPrivate ? (
													<Lock className="ml-auto" aria-label="Private" />
												) : null}
											</span>
										</SelectItem>
									))}
								</SelectPopup>
							</Select>
							<Button
								size="icon-lg"
								variant="ghost"
								aria-label="Refresh GitHub repositories"
								loading={reposLoading}
								onClick={() => void loadGithubRepos()}
							>
								<RefreshCw aria-hidden />
							</Button>
						</div>
						{selectedRepos.length === 0 ? null : (
							<div className="flex flex-wrap gap-1.5">
								{selectedRepos.map((name) => (
									<Badge key={name} variant="secondary" size="lg">
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
						<div className="flex items-center gap-3">
							<Button
								size="sm"
								loading={busy === "connect"}
								disabled={selectedRepos.length === 0}
								onClick={() => void connectProjects()}
							>
								{selectedRepos.length === 0
									? "Build repositories"
									: `Build ${selectedRepos.length} ${selectedRepos.length === 1 ? "repository" : "repositories"}`}
							</Button>
							<p className="text-[11px] text-muted-foreground">
								{selectedRepos.length === 0
									? "Select repositories to create their cloud images."
									: "Creates a clean image for every repository and available compute provider. You can leave while it builds."}
							</p>
						</div>
						{projects.length === 0 ? null : (
							<div className="flex flex-wrap gap-1.5 pt-1">
								{projects.map((project) => (
									<Badge key={project.projectId} variant="secondary" size="lg">
										<GitBranch aria-hidden />
										{project.displayName}
									</Badge>
								))}
							</div>
						)}
						{unfinishedProjects.length === 0 ? null : (
							<div className="overflow-hidden rounded-lg border border-border">
								<div className="px-3 py-2 text-xs font-medium">
									{unfinishedProjects.some(
										(project) => project.state === "preparing",
									)
										? "Building cloud images…"
										: "Cloud image build needs attention"}
								</div>
								<div className="divide-y divide-border border-border border-t">
									{unfinishedProjects.map((project) => (
										<div
											key={project.projectId}
											className="flex items-center gap-3 px-3 py-2 text-[11px]"
										>
											<span className="min-w-0 flex-1 truncate">
												{project.displayName}
											</span>
											<Badge
												variant={
													project.state === "failed"
														? "error"
														: project.state === "preparing"
															? "warning"
															: "outline"
												}
											>
												{project.state === "failed"
													? "Failed"
													: project.state === "preparing"
														? "Building"
														: "Not built"}
											</Badge>
											{project.state !== "preparing" ? (
												<Button
													size="xs"
													variant="ghost"
													loading={busy === `build:${project.projectId}`}
													disabled={providers.length === 0}
													onClick={() => void prepareProject(project)}
												>
													{project.state === "failed"
														? "Retry build"
														: "Build now"}
												</Button>
											) : null}
										</div>
									))}
								</div>
							</div>
						)}
					</div>
					{projectError === null ? null : (
						<p role="alert" className="mt-2 text-xs text-destructive">
							{projectError}
						</p>
					)}
				</SetupSection>
			) : null}

			{subscribed && serviceAvailable ? (
				<SetupSection
					title="Agents"
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
				</SetupSection>
			) : null}

			{subscribed && serviceAvailable && workspaces.length > 0 ? (
				<details className="group rounded-lg border border-border">
					<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
						<ChevronDown className="size-3 transition-transform group-open:rotate-180" />
						Workspace activity
						<Badge variant="outline">{workspaces.length}</Badge>
					</summary>
					<div className="divide-y divide-border border-border border-t">
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
