import { formatNumber as formatUiNumber } from "@zuse/i18n";
import "@zuse/i18n/english/settings";
import {
	CLOUD_WORKSPACE_OFFER_ID,
	type CloudAccountImage,
	type CloudBillingSummary,
	type CloudBillingUsageItem,
	type CloudGithubStatus,
	type CloudProject,
	type CloudProviderOption,
	type CloudWorkspace,
	CloudWorkspaceOpError,
	type GithubRepoSummary,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Cloud } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../hooks/use-auth.ts";
import { cloudProviderLabel } from "../../lib/cloud-provider-presentation.ts";
import { cloudWorkspaceAccessPresentation } from "../../lib/cloud-workspace-access.ts";
import { runControlPlane } from "../../lib/control-plane-client.ts";
import { openExternal } from "../../lib/platform-capabilities.ts";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { SegmentedTabs } from "../ui/segmented-tabs.tsx";
import { CloudApiKeys } from "./cloud-api-keys.tsx";
import { CloudImageBuildHistory } from "./cloud-image-build-history.tsx";
import { CloudImageReadiness } from "./cloud-image-readiness.tsx";
import {
	CloudSettingsGroup,
	CloudSettingsRow,
	COMPACT_CLOUD_ACTION,
} from "./cloud-settings-ui.tsx";
import { CloudWorkspaceAuth } from "./cloud-workspace-auth.tsx";
import { CloudWorkspaceGithub } from "./cloud-workspace-github.tsx";
import { CloudWorkspaceRepositories } from "./cloud-workspace-repositories.tsx";

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
	formatUiNumber(micros / 1_000_000, {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});

export function CloudWorkspacePool() {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	const { isLoading: authLoading, isSignedIn, signIn, signingIn } = useAuth();
	const [entitlementSubscribed, setEntitlementSubscribed] = useState(false);
	const [serviceAvailable, setServiceAvailable] = useState(true);
	const [providers, setProviders] = useState<
		ReadonlyArray<CloudProviderOption>
	>([]);
	const [imageProviderId, setImageProviderId] = useState<string | undefined>();
	const imageSelection = useRef(imageProviderId);
	imageSelection.current = imageProviderId;
	const [projects, setProjects] = useState<ReadonlyArray<CloudProject>>([]);
	const [accountImage, setAccountImage] = useState<CloudAccountImage | null>(
		null,
	);
	const [workspaces, setWorkspaces] = useState<ReadonlyArray<CloudWorkspace>>(
		[],
	);
	const [billing, setBilling] = useState<CloudBillingSummary | null>(null);
	const [billingUsage, setBillingUsage] = useState<
		ReadonlyArray<CloudBillingUsageItem>
	>([]);
	const [capDollars, setCapDollars] = useState("25");
	const [githubRepos, setGithubRepos] = useState<
		ReadonlyArray<GithubRepoSummary>
	>([]);
	const [githubAuthenticated, setGithubAuthenticated] = useState(false);
	const [githubStatus, setGithubStatus] = useState<CloudGithubStatus | null>(
		null,
	);
	const [reposLoading, setReposLoading] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [imageError, setImageError] = useState<string | null>(null);
	const [projectError, setProjectError] = useState<string | null>(null);
	const [view, setView] = useState<"setup" | "usage" | "activity">("setup");
	const access = cloudWorkspaceAccessPresentation({
		entitlementSubscribed,
		serviceAvailable,
	});
	const subscribed = access.subscribed;
	const loadGithubRepos = useCallback(async () => {
		setReposLoading(true);
		try {
			const result = await Promise.race([
				runControlPlane((client) => client["cloud.github.status"]()),
				new Promise<never>((_, reject) =>
					window.setTimeout(
						() => reject(new Error("github_repository_list_timeout")),
						8_000,
					),
				),
			]);
			setGithubStatus(result);
			setGithubRepos(result.repositories);
			setGithubAuthenticated(
				result.installations.some((installation) => !installation.suspended),
			);
		} catch {
			setGithubStatus(null);
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

			const [providerResult, projectResult, workspaceResult, imageResult] =
				await Promise.allSettled([
					runControlPlane((client) => client["cloud.providers"]()),
					runControlPlane((client) => client["cloud.projects.list"]()),
					runControlPlane((client) => client["cloud.workspaces.list"]({})),
					runControlPlane((client) =>
						client["cloud.image.status"]({ providerId: imageProviderId }),
					),
				]);
			const apiResults = [
				providerResult,
				projectResult,
				workspaceResult,
				imageResult,
			] as const;
			const apiAvailable = apiResults.some(
				(result) => result.status === "fulfilled",
			);
			setServiceAvailable(apiAvailable);
			if (providerResult.status === "fulfilled") {
				setProviders(providerResult.value.providers);
			}
			if (projectResult.status === "fulfilled")
				setProjects(projectResult.value.projects);
			if (workspaceResult.status === "fulfilled")
				setWorkspaces(workspaceResult.value.workspaces);
			if (imageSelection.current !== imageProviderId) return;
			if (imageResult.status === "fulfilled")
				setAccountImage(imageResult.value);
			setImageError(
				imageResult.status === "fulfilled"
					? null
					: "Cloud image status is temporarily unavailable. Refresh in a moment; existing cloud chats are unaffected.",
			);
			setError(
				[providerResult, projectResult, workspaceResult].every(
					(result) => result.status === "fulfilled",
				)
					? null
					: apiAvailable
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
	}, [isSignedIn, imageProviderId]);

	useEffect(() => {
		if (authLoading || !isSignedIn) return;
		void load();
		void loadGithubRepos();
		const timer = window.setInterval(() => void load(), 5_000);
		const refreshAfterBrowserFlow = () => {
			void load();
			void loadGithubRepos();
		};
		window.addEventListener("focus", refreshAfterBrowserFlow);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener("focus", refreshAfterBrowserFlow);
		};
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

	const installGithub = () =>
		run("github-install", async () => {
			const result = await runControlPlane((client) =>
				client["cloud.github.install"](),
			);
			await openExternal(result.url);
		});

	const manageGithub = (installationId: number) => {
		const installation = githubStatus?.installations.find(
			(item) => item.installationId === installationId,
		);
		const settingsUrl =
			installation?.accountType === "Organization"
				? `https://github.com/organizations/${encodeURIComponent(installation.accountLogin)}/settings/installations/${installationId}`
				: `https://github.com/settings/installations/${installationId}`;
		return openExternal(settingsUrl);
	};

	const disconnectGithub = (installationId: number) =>
		run(`github-disconnect:${installationId}`, async () => {
			await runControlPlane((client) =>
				client["cloud.github.disconnect"]({ installationId }),
			);
			await loadGithubRepos();
		});

	const connectProjects = (selectedRepos: ReadonlyArray<string>) => {
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
				const failure = results.find((result) => result.status === "rejected");
				if (failure?.status === "rejected") throw failure.reason;
			},
			setProjectError,
		);
	};

	const buildAccountImage = (mode: "update" | "rebuild") =>
		run(`image:${mode}`, async () => {
			setAccountImage(
				await runControlPlane((client) =>
					client["cloud.image.build"]({
						mode,
						providerId: imageProviderId,
						idempotencyKey: `settings-image:${mode}:${crypto.randomUUID()}`,
					}),
				),
			);
		});

	const removeProject = (project: CloudProject) =>
		run(
			`remove:${project.projectId}`,
			async () => {
				await runControlPlane((client) =>
					client["cloud.projects.remove"]({ projectId: project.projectId }),
				);
				setProjects((current) =>
					current.filter((item) => item.projectId !== project.projectId),
				);
			},
			setProjectError,
		);

	if (authLoading) return null;
	if (!isSignedIn) {
		return (
			<section className="flex items-center gap-4 rounded-lg bg-card px-3 py-3 ring-1 ring-inset ring-border/70">
				<div className="min-w-0 flex-1">
					<h2 className="text-xs font-medium text-foreground">
						{uiMessage(
							"settings:cloud_workspace_pool_sign_in_to_set_up_cloud_workspaces",
						)}
					</h2>
					<p className="mt-0.5 max-w-xl text-[11px] leading-4 text-muted-foreground">
						{uiMessage(
							"settings:cloud_workspace_pool_choose_a_plan_connect_repositories_and_authorize_your_coding_agents_fr",
						)}
					</p>
					<p className="mt-1 text-[10px] text-muted-foreground/75">
						{uiMessage(
							"settings:cloud_workspace_pool_local_chats_stay_on_this_computer_and_remain_available_without_an_acco",
						)}
					</p>
				</div>
				<div className="shrink-0">
					<Button
						size="xs"
						className={COMPACT_CLOUD_ACTION}
						loading={signingIn}
						onClick={() => void signIn()}
					>
						{uiMessage("common:signIn")}
					</Button>
				</div>
			</section>
		);
	}
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
					className="rounded-md bg-alert-error-bg px-3 py-2 text-[11px] text-destructive ring-1 ring-inset ring-destructive/10"
				>
					{error}
				</div>
			)}
			<CloudSettingsGroup
				title={uiMessage("settings:cloud_workspace_pool_cloud_access")}
				description={uiMessage(
					"settings:cloud_workspace_pool_cloud_workspaces_keep_agents_running_when_this_app_or_your_laptop_is_o",
				)}
				action={
					subscribed ? (
						<Badge variant={serviceAvailable ? "success" : "warning"}>
							{serviceAvailable
								? uiMessage("settings:cloud_workspace_pool_ready")
								: uiMessage("settings:cloud_workspace_pool_update_required")}
						</Badge>
					) : (
						<Button
							size="xs"
							className={COMPACT_CLOUD_ACTION}
							loading={busy === "checkout"}
							onClick={() => void checkout()}
						>
							{uiMessage("settings:cloud_workspace_pool_subscribe_40_month")}
						</Button>
					)
				}
			>
				<CloudSettingsRow
					title={
						subscribed
							? uiMessage(
									"settings:cloud_workspace_pool_cloud_workspace_is_ready",
								)
							: uiMessage(
									"settings:cloud_workspace_pool_enable_cloud_workspace",
								)
					}
					description={uiMessage(
						"settings:cloud_workspace_pool_each_chat_gets_an_isolated_workspace_compute_pauses_when_it_is_not_nee",
					)}
					action={
						<Cloud className="size-4 text-muted-foreground" aria-hidden />
					}
				/>
			</CloudSettingsGroup>

			{subscribed && serviceAvailable ? (
				<SegmentedTabs
					value={view}
					onValueChange={setView}
					ariaLabel={uiMessage("common:cloud_workspace_settings")}
					className="max-w-sm"
					options={[
						{ value: "setup", label: "Setup" },
						{ value: "usage", label: "Usage" },
						{ value: "activity", label: "Activity" },
					]}
				/>
			) : null}

			{subscribed && serviceAvailable && view === "setup" ? (
				<>
					<CloudWorkspaceGithub
						status={githubStatus}
						loading={reposLoading}
						busy={busy}
						onInstall={() => void installGithub()}
						onManage={(installationId) => void manageGithub(installationId)}
						onRefresh={() => void loadGithubRepos()}
						onDisconnect={(installationId) =>
							void disconnectGithub(installationId)
						}
					/>
					<CloudWorkspaceRepositories
						projects={projects}
						repositories={githubRepos}
						githubAuthenticated={githubAuthenticated}
						loading={reposLoading}
						busy={busy}
						error={projectError}
						onRefresh={() => void loadGithubRepos()}
						onAdd={(names) => void connectProjects(names)}
						onRemove={(project) => void removeProject(project)}
					/>
					<CloudWorkspaceAuth />
					<CloudApiKeys />
					<CloudSettingsGroup
						title={uiMessage("settings:cloud_workspace_pool_cloud_image")}
						description={uiMessage(
							"settings:cloud_workspace_pool_build_the_reusable_environment_that_starts_every_new_cloud_chat",
						)}
					>
						<CloudSettingsRow
							title={uiMessage("settings:cloud_machine_provider")}
						>
							<select
								aria-label={uiMessage("settings:cloud_machine_provider")}
								className="h-7 rounded-md bg-muted px-2 text-xs"
								disabled={busy !== null}
								value={
									imageProviderId ??
									accountImage?.providerId ??
									providers[0]?.providerId ??
									""
								}
								onChange={(event) => {
									setAccountImage(null);
									setImageProviderId(event.target.value);
								}}
							>
								{providers.map((provider) => (
									<option key={provider.providerId} value={provider.providerId}>
										{cloudProviderLabel(provider.providerId)}
									</option>
								))}
							</select>
						</CloudSettingsRow>
						<CloudImageReadiness
							image={accountImage}
							projects={projects}
							busy={busy}
							unavailable={imageError !== null || providers.length === 0}
							onBuild={(mode) => void buildAccountImage(mode)}
						/>
						{imageError === null ? null : (
							<div className="flex items-center justify-between gap-3 bg-destructive/10 px-3 py-2">
								<p role="alert" className="text-xs text-destructive">
									{imageError}
								</p>
								<Button
									size="xs"
									variant="ghost"
									className={COMPACT_CLOUD_ACTION}
									onClick={() => void load()}
								>
									{uiMessage("common:retry")}
								</Button>
							</div>
						)}
						{imageError === null && providers.length === 0 ? (
							<p
								role="status"
								className="px-3 py-2 text-[11px] text-muted-foreground"
							>
								{uiMessage("settings:cloud_workspace_pool_setup_unavailable")}
							</p>
						) : null}
						<CloudImageBuildHistory builds={accountImage?.builds ?? []} />
					</CloudSettingsGroup>
				</>
			) : null}

			{subscribed && serviceAvailable && view === "usage" ? (
				billing === null ? (
					<CloudSettingsGroup
						title={uiMessage("settings:cloud_workspace_pool_usage_and_billing")}
						description={uiMessage(
							"settings:cloud_workspace_pool_usage_details_are_temporarily_unavailable",
						)}
					>
						<CloudSettingsRow
							title={uiMessage(
								"settings:cloud_workspace_pool_could_not_load_billing",
							)}
							description={uiMessage(
								"settings:cloud_workspace_pool_refresh_cloud_settings_to_try_again_existing_workspaces_are_unaffected",
							)}
							action={
								<Button
									size="xs"
									variant="ghost"
									className={COMPACT_CLOUD_ACTION}
									onClick={() => void load()}
								>
									{uiMessage("common:retry")}
								</Button>
							}
						/>
					</CloudSettingsGroup>
				) : (
					<CloudSettingsGroup
						title={uiMessage("settings:cloud_workspace_pool_usage_and_billing")}
						description={uiMessage(
							"settings:cloud_workspace_pool_40_month_includes_35_of_sandbox_compute_additional_compute_is_billed_a",
						)}
						action={
							<Badge
								variant={
									billing.status === "billing-hold" ? "warning" : "success"
								}
							>
								{billing.status === "billing-hold"
									? uiMessage("settings:cloud_workspace_pool_paused")
									: uiMessage("settings:cloud_workspace_pool_active")}
							</Badge>
						}
					>
						{overageWarning === null ? null : (
							<CloudSettingsRow
								title={
									overageCapPercent >= 100
										? uiMessage("settings:cloud_workspace_pool_billing_hold")
										: uiMessage("settings:cloud_workspace_pool_usage_warning")
								}
								description={overageWarning}
								action={<Badge variant="warning">{overageCapPercent}%</Badge>}
							/>
						)}
						<CloudSettingsRow
							title={uiMessage(
								"settings:cloud_workspace_pool_of_35_00_included_used",
								{ value1: String(formatUsdMicros(billing.includedUsedMicros)) },
							)}
							description={uiMessage(
								"settings:cloud_workspace_pool_remaining_overage_invoice_estimate_before_tax",
								{
									value1: String(
										formatUsdMicros(billing.includedRemainingMicros),
									),
									value2: String(formatUsdMicros(billing.overageChargeMicros)),
									value3: String(
										formatUsdMicros(billing.currentInvoiceEstimateMicros),
									),
								},
							)}
						/>
						<CloudSettingsRow
							title={uiMessage(
								"settings:cloud_workspace_pool_monthly_overage_cap",
							)}
							description={uiMessage(
								"settings:cloud_workspace_pool_builds_and_running_workspaces_pause_when_this_pre_tax_limit_is_reached",
							)}
							action={
								<>
									<Input
										type="number"
										min="0"
										step="1"
										value={capDollars}
										onChange={(event) =>
											setCapDollars(event.currentTarget.value)
										}
										className="h-7 w-20"
										aria-label={uiMessage(
											"settings:cloud_workspace_pool_monthly_overage_cap_in_dollars",
										)}
									/>
									<Button
										size="xs"
										className={COMPACT_CLOUD_ACTION}
										loading={busy === "billing-cap"}
										onClick={() => void saveOverageCap()}
									>
										{uiMessage("common:save")}
									</Button>
								</>
							}
						/>
						<CloudSettingsRow
							title={uiMessage("settings:cloud_workspace_pool_recent_usage")}
							description={
								billingUsage.length === 0
									? uiMessage(
											"settings:cloud_workspace_pool_no_completed_sandbox_runs_in_this_billing_period",
										)
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
									className={COMPACT_CLOUD_ACTION}
									loading={busy === "billing-portal"}
									onClick={() => void openBillingPortal()}
								>
									{uiMessage("settings:cloud_workspace_pool_invoices")}
								</Button>
							}
						/>
					</CloudSettingsGroup>
				)
			) : null}

			{subscribed && serviceAvailable && view === "activity" ? (
				<CloudSettingsGroup
					title={uiMessage("settings:cloud_workspace_pool_workspace_activity")}
					description={uiMessage(
						"settings:cloud_workspace_pool_current_and_recent_cloud_workspaces_for_this_account",
					)}
					action={<Badge variant="outline">{workspaces.length}</Badge>}
				>
					{workspaces.length === 0 ? (
						<CloudSettingsRow
							title={uiMessage(
								"settings:cloud_workspace_pool_no_cloud_workspaces_yet",
							)}
							description={uiMessage(
								"settings:cloud_workspace_pool_start_a_cloud_chat_and_its_workspace_will_appear_here",
							)}
						/>
					) : (
						workspaces.map((workspace) => (
							<CloudSettingsRow
								key={workspace.workspaceId}
								title={workspace.branch}
								description={workspace.statusCode}
								action={
									<Badge variant={stateVariant(workspace.state)}>
										{workspace.state}
									</Badge>
								}
							/>
						))
					)}
				</CloudSettingsGroup>
			) : null}
		</>
	);
}
