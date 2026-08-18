import {
	CLOUD_WORKSPACE_OFFER_ID,
	type CloudBillingSummary,
	type CloudBillingUsageItem,
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

const formatUsdMicros = (micros: number): string =>
	new Intl.NumberFormat(undefined, {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	}).format(micros / 1_000_000);

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
	const [billing, setBilling] = useState<CloudBillingSummary | null>(null);
	const [billingUsage, setBillingUsage] = useState<
		ReadonlyArray<CloudBillingUsageItem>
	>([]);
	const [capDollars, setCapDollars] = useState("25");
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
				if (loadedSubscribed) {
					const [summary, usage] = await Promise.all([
						runControlPlane((client) => client["cloud.billing.summary"]()),
						runControlPlane((client) =>
							client["cloud.billing.usage"]({ limit: 20 }),
						),
					]);
					setBilling(summary);
					setBillingUsage(usage.items);
					setCapDollars(String(summary.overageCapMicros / 1_000_000));
				}
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
		const handleFocus = () => void load();
		window.addEventListener("focus", handleFocus);
		return () => window.removeEventListener("focus", handleFocus);
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

	const saveOverageCap = () =>
		run("billing-cap", async () => {
			const micros = Math.round(Number(capDollars) * 1_000_000);
			if (!Number.isSafeInteger(micros) || micros < 0)
				throw new Error("invalid cap");
			const summary = await runControlPlane((client) =>
				client["cloud.billing.setCap"]({
					overageCapMicros: micros,
					idempotencyKey: `settings-cap:${crypto.randomUUID()}`,
				}),
			);
			setBilling(summary);
		});

	const openBillingPortal = () =>
		run("billing-portal", async () => {
			const portal = await runControlPlane((client) =>
				client["machines.billingPortal"](),
			);
			await openExternal(portal.portalUrl);
		});

	const connectProjects = () => {
		setProjectError(null);
		return run(
			"connect",
			async () => {
				const chosen = githubRepos.filter((repo) =>
					selectedRepos.includes(repo.nameWithOwner),
				);
				const results = await Promise.allSettled(
					chosen.map((repo) =>
						runControlPlane((client) =>
							client["cloud.projects.connect"]({
								repositoryUrl: repo.httpsUrl,
								defaultBranch: repo.defaultBranch,
								visibility: repo.isPrivate ? "private" : "public",
								displayName: repo.nameWithOwner,
								idempotencyKey: `settings-connect:${repo.nameWithOwner}:${repo.defaultBranch}`,
							}),
						).then((project) => ({ project, repo: repo.nameWithOwner })),
					),
				);
				const connected = results.flatMap((result) =>
					result.status === "fulfilled" ? [result.value] : [],
				);
				setProjects((current) => {
					const ids = new Set(
						connected.map(({ project }) => project.projectId),
					);
					return [
						...current.filter((project) => !ids.has(project.projectId)),
						...connected.map(({ project }) => project),
					];
				});
				const connectedRepos = new Set(connected.map(({ repo }) => repo));
				setSelectedRepos((current) =>
					current.filter((repo) => !connectedRepos.has(repo)),
				);
				const failure = results.find((result) => result.status === "rejected");
				if (failure?.status === "rejected") throw failure.reason;
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
			<CloudSettingsGroup
				title="Cloud Workspace · Beta"
				description="Your saved chats remain available on this device. Sign in again to access cloud compute and billing."
				action={
					<Button size="xs" loading={signingIn} onClick={() => void signIn()}>
						Sign in
					</Button>
				}
			>
				<CloudSettingsRow
					title="Sign in to continue"
					description="Your account session expired. You do not need to sign out first."
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
	const normalizedRepoSearch = repoSearch.trim().toLowerCase();
	const filteredRepos =
		normalizedRepoSearch.length === 0
			? availableRepos
			: availableRepos.filter(
					(repo) =>
						repo.nameWithOwner.toLowerCase().includes(normalizedRepoSearch) ||
						repo.description?.toLowerCase().includes(normalizedRepoSearch),
				);
	const unfinishedProjects = projects.filter(
		(project) => project.state !== "ready",
	);
	const overageCapPercent =
		billing === null
			? 0
			: billing.overageCapMicros <= 0
				? billing.overageProviderCostMicros > 0
					? 100
					: 0
				: Math.min(
						100,
						Math.floor(
							(billing.overageChargeMicros / billing.overageCapMicros) * 100,
						),
					);
	const overageWarning =
		overageCapPercent >= 100
			? "The overage cap is exhausted. New billable operations are blocked and running compute is being paused."
			: overageCapPercent >= 80
				? `You have used ${overageCapPercent}% of this period's overage cap.`
				: overageCapPercent >= 50
					? `You have used ${overageCapPercent}% of this period's overage cap.`
					: null;

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
			<CloudSettingsGroup
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
							Subscribe · $40/month
						</Button>
					)
				}
			>
				<CloudSettingsRow
					title={
						subscribed ? "Cloud workspace is ready" : "Enable Cloud Workspace"
					}
					description="Each chat gets an isolated workspace. Compute pauses when it is not needed."
					action={
						<Cloud className="size-4 text-muted-foreground" aria-hidden />
					}
				/>
			</CloudSettingsGroup>

			{subscribed && serviceAvailable && billing !== null ? (
				<CloudSettingsGroup
					title="Usage and billing"
					description="$40/month includes the first $35 of actual sandbox compute. Additional compute is billed at provider cost + 5%; unused allowance does not roll over."
					action={
						<Badge
							variant={
								billing.status === "billing-hold" ? "warning" : "success"
							}
						>
							{billing.status === "billing-hold" ? "Usage paused" : "Active"}
						</Badge>
					}
				>
					{overageWarning === null ? null : (
						<CloudSettingsRow
							title={
								overageCapPercent >= 100 ? "Billing hold" : "Usage warning"
							}
							description={overageWarning}
							action={<Badge variant="warning">{overageCapPercent}%</Badge>}
						/>
					)}
					<CloudSettingsRow
						title={`${formatUsdMicros(billing.includedUsedMicros)} of $35.00 included used`}
						description={`${formatUsdMicros(billing.includedRemainingMicros)} included remaining · ${formatUsdMicros(billing.overageChargeMicros)} current overage · ${formatUsdMicros(billing.currentInvoiceEstimateMicros)} current invoice estimate before tax.`}
					/>
					<CloudSettingsRow
						title="Monthly overage cap"
						description="Running workspaces and builds pause at this pre-tax overage amount. The cap cannot be set below usage already incurred."
						action={
							<>
								<Input
									size="sm"
									type="number"
									min="0"
									step="1"
									value={capDollars}
									onChange={(event) => setCapDollars(event.currentTarget.value)}
									className="w-20"
									aria-label="Monthly overage cap in dollars"
								/>
								<Button
									size="xs"
									loading={busy === "billing-cap"}
									onClick={() => void saveOverageCap()}
								>
									Save
								</Button>
							</>
						}
					/>
					<CloudSettingsRow
						title="Recent usage"
						description={
							billingUsage.length === 0
								? "No completed sandbox executions in this billing period yet."
								: billingUsage
										.slice(0, 3)
										.map(
											(item) =>
												`${item.resourceKind} ${item.resourceId}: ${formatUsdMicros(item.providerCostMicros)}${item.status === "provisional" ? " (provisional)" : ""}`,
										)
										.join(" · ")
						}
						action={
							<Button
								size="xs"
								variant="ghost"
								loading={busy === "billing-portal"}
								onClick={() => void openBillingPortal()}
							>
								Invoices
							</Button>
						}
					/>
					<p className="px-3 py-2 text-[10px] text-muted-foreground">
						The fixed platform reserve covers billing, Cloudflare, and operating
						costs; it is not guaranteed margin. Taxes are handled separately at
						checkout.
					</p>
				</CloudSettingsGroup>
			) : null}

			{subscribed && serviceAvailable ? (
				<CloudSettingsGroup
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
				</CloudSettingsGroup>
			) : null}

			{subscribed && serviceAvailable ? (
				<CloudSettingsGroup
					title="Repositories"
					description="Choose repositories from GitHub, then build the cloud images used to start new workspaces."
				>
					<div className="space-y-2.5 px-3 py-2.5">
						<p className="text-[11px] text-muted-foreground">
							{githubAuthenticated
								? "Select repositories, then build their cloud images."
								: "Run gh auth login on this Mac, then refresh."}
						</p>
						<div className="flex items-center gap-1.5">
							<Popover>
								<PopoverTrigger
									disabled={!githubConnected || !githubAuthenticated}
									className="flex h-7 w-64 max-w-full items-center justify-between rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none hover:bg-muted disabled:opacity-50"
								>
									<span className="truncate">
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
									className="w-80 [&_[data-slot=popover-viewport]]:p-1"
								>
									<Input
										size="sm"
										type="search"
										value={repoSearch}
										onChange={(event) =>
											setRepoSearch(event.currentTarget.value)
										}
										placeholder="Search repositories"
										autoFocus
									/>
									<div className="mt-1 max-h-48 overflow-y-auto">
										{filteredRepos.length === 0 ? (
											<p className="px-2 py-4 text-center text-[11px] text-muted-foreground">
												No repositories found.
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
														className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-muted"
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
														<span className="min-w-0 flex-1 truncate">
															{repo.nameWithOwner}
														</span>
														{repo.isPrivate ? (
															<Lock
																className="size-3 text-muted-foreground"
																aria-label="Private"
															/>
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
								size="icon"
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
									<Badge key={name} variant="secondary">
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
									<Badge key={project.projectId} variant="secondary">
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
						{projectError === null ? null : (
							<p role="alert" className="mt-2 text-xs text-destructive">
								{projectError}
							</p>
						)}
					</div>
				</CloudSettingsGroup>
			) : null}

			{subscribed && serviceAvailable ? (
				<CloudSettingsGroup
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
				</CloudSettingsGroup>
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
