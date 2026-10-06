import { formatNumber as formatUiNumber } from "@zuse/i18n";
import { githubInstallationSettingsUrl } from "@zuse/utils/github-installation";
import { startCloudCheckout } from "../../lib/cloud-checkout.ts";
import {
	cloudImageGroupStatus,
	rebuildCloudImages,
	reconcileCloudImages,
} from "../../lib/cloud-image-group.ts";
import {
	refreshCloudImages,
	subscribeCloudImages,
} from "../../lib/cloud-image-monitor.ts";
import {
	type CloudSetupProgress,
	type CloudSetupStep,
	requestCloudOnboarding,
} from "../../lib/cloud-onboarding.ts";
import { peekCloudGithub } from "../../lib/cloud-workspace-session-cache.ts";
import { connectGithub } from "../../lib/connect-github.ts";
import "@zuse/i18n/english/settings";
import {
	type CloudAccountImage,
	type CloudBillingSummary,
	type CloudBillingUsageItem,
	type CloudGithubStatus,
	type CloudProject,
	type CloudProviderOption,
	type CloudWorkspace,
	CloudWorkspaceOpError,
	type GithubRepoSummary,
	type WorkspaceScope,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Cloud } from "lucide-react";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useAuth } from "../../hooks/use-auth.ts";
import {
	cloudProviderLabel,
	selectedCloudProvider,
} from "../../lib/cloud-provider-presentation.ts";
import { cloudWorkspaceAccessPresentation } from "../../lib/cloud-workspace-access.ts";
import {
	hasCloudEntitlement,
	invalidateCloudProjects,
	loadCloudBillingSummary,
	loadCloudBillingUsage,
	loadCloudEntitlements,
	loadCloudGithub,
	loadCloudProjects,
	loadCloudProviderImages,
	loadCloudProviders,
	loadCloudWorkspaces,
} from "../../lib/cloud-workspace-session-cache.ts";
import {
	runCloudControl,
	subscribeControlPlaneSessionCache,
} from "../../lib/control-plane-client.ts";
import { useOrganizationWorkspaces } from "../../lib/organization-workspaces.ts";
import { openExternal } from "../../lib/platform-capabilities.ts";
import {
	rendererWorkspaceSnapshot,
	subscribeRendererWorkspace,
} from "../../lib/renderer-workspace.ts";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { SegmentedTabs } from "../ui/segmented-tabs.tsx";
import { CloudApiKeys } from "./cloud-api-keys.tsx";
import { CloudImageProviders } from "./cloud-image-providers.tsx";
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

type CloudWorkspacePoolProps = {
	section?: "all" | "repositories" | "image" | "agents" | "billing";
	onboarding?: {
		readonly step: CloudSetupStep;
		readonly onProgress: (
			progress: CloudSetupProgress,
			loaded: boolean,
		) => void;
	};
};

export function CloudWorkspacePool({
	section = "all",
	onboarding,
}: CloudWorkspacePoolProps = {}) {
	const { message } = useUiMessages(["settings"]);
	const workspace = useSyncExternalStore(
		subscribeRendererWorkspace,
		rendererWorkspaceSnapshot,
		rendererWorkspaceSnapshot,
	);
	const organization = useOrganizationWorkspaces((state) =>
		state.organizations.find(
			(entry) =>
				workspace.scope.kind === "organization" &&
				entry.id === workspace.scope.organizationId,
		),
	);
	const name =
		workspace.scope.kind === "personal"
			? message("settings:workspace_personal")
			: (organization?.name ?? workspace.scope.organizationId);
	const canManageBilling =
		workspace.scope.kind === "personal" ||
		organization?.role === "admin" ||
		organization?.role === "billing";
	return (
		<ScopedCloudWorkspacePool
			key={`${workspace.key}:${workspace.epoch}`}
			section={organization?.role === "billing" ? "billing" : section}
			workspaceName={name}
			workspaceScope={workspace.scope}
			canManageBilling={canManageBilling}
			onboarding={onboarding}
		/>
	);
}

function ScopedCloudWorkspacePool({
	onboarding,
	section,
	workspaceName,
	workspaceScope,
	canManageBilling,
}: {
	onboarding?: CloudWorkspacePoolProps["onboarding"];
	section: NonNullable<CloudWorkspacePoolProps["section"]>;
	workspaceName: string;
	workspaceScope: WorkspaceScope;
	canManageBilling: boolean;
}) {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	const { isLoading: authLoading, isSignedIn, signIn, signingIn } = useAuth();
	const [setupLoading, setSetupLoading] = useState(true);
	const [entitlementSubscribed, setEntitlementSubscribed] = useState(false);
	const [serviceAvailable, setServiceAvailable] = useState(true);
	const [providers, setProviders] = useState<
		ReadonlyArray<CloudProviderOption>
	>([]);
	const loadSequence = useRef(0);
	const [projects, setProjects] = useState<ReadonlyArray<CloudProject>>([]);
	const [providerImages, setProviderImages] = useState<
		readonly CloudAccountImage[]
	>([]);
	useEffect(
		() =>
			subscribeCloudImages((images) =>
				setProviderImages((current) => reconcileCloudImages(current, images)),
			),
		[],
	);
	const [chosenProvider, setChosenProvider] = useState<string | null>(null);
	const selectedProvider = selectedCloudProvider(providers, chosenProvider);
	const accountImage = cloudImageGroupStatus(
		selectedProvider === null ? [] : [selectedProvider],
		providerImages,
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
	>(() => peekCloudGithub()?.repositories ?? []);
	const [githubAuthenticated, setGithubAuthenticated] = useState(
		() =>
			peekCloudGithub()?.installations.some(
				(installation) => !installation.suspended,
			) ?? false,
	);
	const [githubStatus, setGithubStatus] = useState<CloudGithubStatus | null>(
		() => peekCloudGithub() ?? null,
	);
	const [reposLoading, setReposLoading] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [buildError, setBuildError] = useState<string | null>(null);
	const [imageLoadError, setImageLoadError] = useState<string | null>(null);
	const [failedImageProviders, setFailedImageProviders] = useState<
		readonly string[] | null
	>(null);
	const imageError =
		failedImageProviders !== null &&
		selectedProvider !== null &&
		!failedImageProviders.includes(selectedProvider)
			? null
			: imageLoadError;
	const [projectError, setProjectError] = useState<string | null>(null);
	const [view, setView] = useState<"setup" | "usage" | "activity">("setup");
	const access = cloudWorkspaceAccessPresentation({
		entitlementSubscribed,
		serviceAvailable,
	});
	const subscribed = access.subscribed;
	const loadGithubRepos = useCallback(async (refresh = false) => {
		setReposLoading(peekCloudGithub() === undefined);
		try {
			const result = await Promise.race([
				loadCloudGithub(refresh),
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
			// Keep the last successful repository list during transient failures.
		} finally {
			setReposLoading(false);
		}
	}, []);

	const load = useCallback(
		async (refresh = false) => {
			if (!isSignedIn) return;
			const requestSequence = ++loadSequence.current;
			const billingImages =
				section === "billing"
					? loadCloudProviders(refresh)
							.then(({ providers }) =>
								loadCloudProviderImages(providers, refresh),
							)
							.catch(() => undefined)
					: undefined;
			const workspaceData =
				section === "billing"
					? undefined
					: Promise.allSettled([
							loadCloudProviders(refresh),
							loadCloudProjects(refresh),
							loadCloudWorkspaces(refresh),
							loadCloudProviders(refresh).then(({ providers }) =>
								loadCloudProviderImages(providers, refresh),
							),
						]);
			let loadedSubscribed = false;
			try {
				try {
					const entitlements = await loadCloudEntitlements(refresh);
					if (requestSequence !== loadSequence.current) return;
					loadedSubscribed = hasCloudEntitlement(entitlements);
					setEntitlementSubscribed(loadedSubscribed);
					if (loadedSubscribed && canManageBilling) {
						const [summary, usage] = await Promise.all([
							loadCloudBillingSummary(refresh),
							loadCloudBillingUsage(refresh),
						]);
						if (requestSequence !== loadSequence.current) return;
						setBilling(summary);
						setBillingUsage(usage.items);
						setCapDollars(String(summary.overageCapMicros / 1_000_000));
					}
				} catch {
					if (requestSequence !== loadSequence.current) return;
					if (!loadedSubscribed) {
						setError(
							"Your Cloud Workspace subscription could not be verified.",
						);
					}
				}

				if (workspaceData === undefined) {
					const images = await billingImages;
					if (requestSequence !== loadSequence.current) return;
					if (images !== undefined)
						setProviderImages((current) =>
							reconcileCloudImages(current, images.images),
						);
					setServiceAvailable(true);
					return;
				}
				const [providerResult, projectResult, workspaceResult, imageResult] =
					await workspaceData;
				if (requestSequence !== loadSequence.current) return;
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
				if (imageResult.status === "fulfilled")
					setProviderImages((current) =>
						reconcileCloudImages(current, imageResult.value.images),
					);
				setFailedImageProviders(
					imageResult.status === "fulfilled" &&
						providerResult.status === "fulfilled"
						? providerResult.value.providers
								.filter(
									(provider) =>
										!imageResult.value.images.some(
											(image) => image.providerId === provider.providerId,
										),
								)
								.map((provider) => provider.providerId)
						: null,
				);
				setImageLoadError(
					imageResult.status === "fulfilled" && imageResult.value.complete
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
				if (requestSequence !== loadSequence.current) return;
				setServiceAvailable(false);
				setError(
					cloudWorkspaceAccessPresentation({
						entitlementSubscribed: loadedSubscribed,
						serviceAvailable: false,
					}).serviceError,
				);
			} finally {
				if (requestSequence === loadSequence.current) setSetupLoading(false);
			}
		},
		[isSignedIn, section, canManageBilling],
	);

	useEffect(() => {
		if (authLoading || !isSignedIn) return;
		void load();
		if (section !== "billing") void loadGithubRepos();
		return subscribeControlPlaneSessionCache((key) => {
			if (key === "cloud-workspace:github" && section !== "billing")
				void loadGithubRepos();
			else if (key.startsWith("cloud-workspace:")) void load();
		});
	}, [authLoading, isSignedIn, load, loadGithubRepos, section]);

	const githubReady = githubAuthenticated && projects.length > 0;
	const authReady = providerImages.some((image) =>
		image.providers.some((provider) => provider.state === "connected"),
	);
	const imageReady =
		accountImage?.state === "ready" &&
		!busy?.startsWith("image:") &&
		imageError === null &&
		buildError === null;
	const onProgress = onboarding?.onProgress;
	useEffect(() => {
		onProgress?.(
			{ github: githubReady, auth: authReady, image: imageReady },
			providerImages.length > 0 && githubStatus !== null,
		);
	}, [
		onProgress,
		githubReady,
		authReady,
		imageReady,
		providerImages.length > 0,
		githubStatus !== null,
	]);
	useEffect(() => {
		if (authLoading || !isSignedIn) return;
		const refresh = () => {
			void load(true);
			if (section !== "billing") void loadGithubRepos(true);
		};
		window.addEventListener("focus", refresh);
		window.addEventListener("online", refresh);
		return () => {
			window.removeEventListener("focus", refresh);
			window.removeEventListener("online", refresh);
		};
	}, [authLoading, isSignedIn, section, load, loadGithubRepos]);
	useEffect(() => {
		if (
			authLoading ||
			!isSignedIn ||
			(section !== "repositories" && section !== "all")
		)
			return;
		// Webhooks update the existing API state. Reuse its scoped cache instead
		// of introducing a second realtime transport for settings.
		const timer = window.setInterval(() => {
			if (document.visibilityState === "visible") void loadGithubRepos();
		}, 30_000);
		return () => window.clearInterval(timer);
	}, [authLoading, isSignedIn, section, loadGithubRepos]);

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
			await load(true);
			if (section !== "billing")
				void refreshCloudImages().catch(() => undefined);
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

	const checkout = () => run("checkout", startCloudCheckout);

	const saveOverageCap = () =>
		run("billing-cap", async () => {
			const micros = Math.round(Number(capDollars) * 1_000_000);
			if (!Number.isSafeInteger(micros) || micros < 0)
				throw new Error("invalid cap");
			const summary = await runCloudControl((client) =>
				client["cloud.billing.setCap"]({
					overageCapMicros: micros,
					idempotencyKey: `settings-cap:${crypto.randomUUID()}`,
				}),
			);
			setBilling(summary);
		});

	const openBillingPortal = () =>
		run("billing-portal", () =>
			openExternal(async () => {
				const portal = await runCloudControl((client) =>
					client["machines.billingPortal"](),
				);
				return portal.portalUrl;
			}),
		);

	const installGithub = () => run("github-install", connectGithub);

	const manageGithub = (installationId: number) => {
		const installation = githubStatus?.installations.find(
			(item) => item.installationId === installationId,
		);
		const settingsUrl = githubInstallationSettingsUrl(
			installationId,
			installation,
		);
		return openExternal(settingsUrl);
	};

	const disconnectGithub = (installationId: number) =>
		run(`github-disconnect:${installationId}`, async () => {
			await runCloudControl((client) =>
				client["cloud.github.disconnect"]({ installationId }),
			);
			await loadGithubRepos(true);
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
						runCloudControl((client) =>
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
				// Reads started before this write cannot replace the confirmed projects,
				// including when only part of a multi-repository connection succeeds.
				loadSequence.current += 1;
				invalidateCloudProjects();
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
		run(
			`image:${mode}`,
			async () => {
				setBuildError(null);
				const { providers: available } = await loadCloudProviders(true);
				setProviders(available);
				if (
					!available.some(
						(provider) => provider.providerId === selectedProvider,
					)
				)
					throw new Error("Selected cloud provider is no longer available");
				const result = await rebuildCloudImages(
					selectedProvider === null ? [] : [selectedProvider],
					(providerId) =>
						runCloudControl((client) =>
							client["cloud.image.build"]({
								mode,
								providerId,
								idempotencyKey: `settings-image:${mode}:${crypto.randomUUID()}`,
							}),
						),
				);
				setProviderImages((current) =>
					reconcileCloudImages(current, [
						...current.filter(
							(image) =>
								!result.images.some(
									(next) => next.providerId === image.providerId,
								),
						),
						...result.images,
					]),
				);
				setBuildError(
					result.failedProviderIds.length === 0
						? null
						: uiMessage("settings:cloud_images_start_failed", {
								providers: result.failedProviderIds
									.map(cloudProviderLabel)
									.join(", "),
							}),
				);
				void refreshCloudImages().catch(() => undefined);
			},
			setBuildError,
		);

	const removeProject = (project: CloudProject) =>
		run(
			`remove:${project.projectId}`,
			async () => {
				await runCloudControl((client) =>
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
			{onboarding !== undefined && setupLoading ? (
				<p role="status" className="py-3 text-xs text-muted-foreground">
					{uiMessage("common:loading")}
				</p>
			) : null}
			<p className="text-xs font-medium text-foreground">
				{uiMessage("settings:workspace_billing_identity", {
					workspace: workspaceName,
				})}
			</p>
			{!canManageBilling && (
				<p className="text-xs text-muted-foreground">
					{uiMessage("settings:workspace_billing_managers_only")}
				</p>
			)}
			{error === null ? null : (
				<div
					role="alert"
					className="rounded-md bg-alert-error-bg px-3 py-2 text-[11px] text-destructive ring-1 ring-inset ring-destructive/10"
				>
					{error}
				</div>
			)}
			{onboarding === undefined ? (
				<CloudSettingsGroup
					title={uiMessage("settings:cloud_workspace_pool_cloud_access")}
					description={uiMessage(
						"settings:cloud_workspace_pool_cloud_workspaces_keep_agents_running_when_this_app_or_your_laptop_is_o",
					)}
					action={
						subscribed ? (
							<Badge variant={serviceAvailable ? "success" : "warning"}>
								{serviceAvailable
									? uiMessage("settings:cloud_workspace_pool_active")
									: uiMessage("settings:cloud_workspace_pool_update_required")}
							</Badge>
						) : canManageBilling ? (
							<Button
								size="xs"
								className={COMPACT_CLOUD_ACTION}
								loading={busy === "checkout"}
								onClick={() => void checkout()}
							>
								{uiMessage("settings:cloud_workspace_pool_subscribe_40_month")}
							</Button>
						) : null
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
			) : null}

			{onboarding === undefined &&
			subscribed &&
			serviceAvailable &&
			section === "all" ? (
				<SegmentedTabs
					value={view}
					onValueChange={setView}
					ariaLabel={uiMessage("common:cloud_workspace_settings")}
					className="max-w-sm"
					options={[
						{ value: "setup", label: "Setup" },
						...(canManageBilling
							? [{ value: "usage" as const, label: "Usage" }]
							: []),
						{ value: "activity", label: "Activity" },
					]}
				/>
			) : null}

			{subscribed &&
			serviceAvailable &&
			section !== "billing" &&
			(section !== "all" || view === "setup") ? (
				<>
					{(section === "all" || section === "repositories") &&
					(onboarding === undefined || onboarding.step === "github") ? (
						<>
							<CloudWorkspaceGithub
								status={githubStatus}
								loading={reposLoading}
								busy={busy}
								onInstall={() => void installGithub()}
								onManage={(installationId) => void manageGithub(installationId)}
								onRefresh={() => void loadGithubRepos(true)}
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
								onRefresh={() => void loadGithubRepos(true)}
								onAdd={(names) => void connectProjects(names)}
								onRemove={(project) => void removeProject(project)}
							/>
						</>
					) : null}
					{(section === "all" || section === "agents") &&
					(onboarding === undefined || onboarding.step === "auth") ? (
						<>
							<CloudWorkspaceAuth />
							<CloudApiKeys scope={workspaceScope} />
						</>
					) : null}
					{(section === "all" || section === "image") &&
					(onboarding === undefined || onboarding.step === "image") ? (
						<CloudSettingsGroup
							title={uiMessage("settings:cloud_workspace_pool_cloud_image")}
							description={uiMessage(
								"settings:cloud_images_selected_description",
							)}
						>
							{onboarding === undefined ? (
								<CloudSettingsRow
									title={uiMessage("settings:cloud_setup_title")}
									description={uiMessage(
										"settings:cloud_setup_guide_description",
									)}
									action={
										<Button
											className={COMPACT_CLOUD_ACTION}
											variant="ghost"
											onClick={requestCloudOnboarding}
										>
											{uiMessage("settings:cloud_setup_open_guide")}
										</Button>
									}
								/>
							) : null}
							<CloudImageProviders
								providers={providers}
								images={providerImages}
								selectedProvider={selectedProvider}
								onSelectProvider={(providerId) => {
									setChosenProvider(providerId);
									setBuildError(null);
								}}
								disabled={busy !== null}
							/>
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
										onClick={() => void load(true)}
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
							{buildError === null ? null : (
								<p role="alert" className="px-3 py-2 text-xs text-destructive">
									{buildError}
								</p>
							)}
						</CloudSettingsGroup>
					) : null}
				</>
			) : null}

			{canManageBilling &&
			(section === "billing" || (section === "all" && view === "usage")) ? (
				<CloudSettingsGroup title={uiMessage("settings:workspace_billing")}>
					<CloudSettingsRow
						title={uiMessage("settings:cloud_workspace_pool_invoices")}
						description={uiMessage(
							"settings:cloud_machines_pane_manage_payment_details_and_invoices_in_the_billing_portal",
						)}
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
			) : null}

			{serviceAvailable &&
			canManageBilling &&
			(section === "billing" ||
				section === "image" ||
				(section === "all" && view === "usage")) ? (
				<CloudSettingsGroup
					title={uiMessage("settings:cloud_snapshot_storage")}
					description={uiMessage("settings:cloud_snapshot_storage_rate")}
				>
					<CloudSettingsRow
						title={uiMessage("settings:cloud_snapshot_retained_images")}
						description={uiMessage("settings:cloud_snapshot_storage_allowance")}
						action={
							<Badge variant="outline">
								{
									providerImages.filter(
										(image) => image.storage?.state === "retained",
									).length
								}
							</Badge>
						}
					/>
					{providerImages
						.filter((image) => image.storage !== undefined)
						.map((image) => {
							const storage = image.storage;
							if (storage === undefined) return null;
							return (
								<CloudSettingsRow
									key={storage.snapshotId}
									title={cloudProviderLabel(image.providerId ?? "box")}
									description={
										storage.state === "deleting"
											? uiMessage("settings:cloud_snapshot_deletion_pending")
											: storage.graceUntil !== undefined
												? uiMessage("settings:cloud_snapshot_grace", {
														date: new Date(storage.graceUntil).toLocaleString(),
													})
												: storage.billingEnabled
													? uiMessage(
															"settings:cloud_snapshot_delete_explanation",
														)
													: uiMessage(
															"settings:cloud_snapshot_billing_not_started",
														)
									}
									action={
										<Button
											size="xs"
											variant="ghost"
											className={COMPACT_CLOUD_ACTION}
											disabled={storage.state === "deleting" || busy !== null}
											loading={busy === "delete-image"}
											onClick={() =>
												void run("delete-image", async () => {
													await runCloudControl((client) =>
														client["cloud.image.delete"]({
															snapshotId: storage.snapshotId,
														}),
													);
													await refreshCloudImages();
												})
											}
										>
											{uiMessage("settings:cloud_snapshot_delete_image")}
										</Button>
									}
								/>
							);
						})}
					<CloudSettingsRow
						title={uiMessage("settings:cloud_snapshot_usage")}
						action={
							<Badge variant="outline">
								{billing?.storageCostMicros === undefined
									? "—"
									: formatUsdMicros(billing.storageCostMicros)}
							</Badge>
						}
						description={uiMessage("settings:cloud_snapshot_usage_recent")}
					/>
				</CloudSettingsGroup>
			) : null}

			{subscribed &&
			serviceAvailable &&
			canManageBilling &&
			(section === "billing" || (section === "all" && view === "usage")) ? (
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
									onClick={() => void load(true)}
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
													`${item.usageKind ?? item.resourceKind} ${item.resourceId}: ${formatUsdMicros(item.providerCostMicros)}${item.status === "provisional" ? " (provisional)" : ""}`,
											)
											.join(" · ")
							}
						/>
					</CloudSettingsGroup>
				)
			) : null}

			{subscribed &&
			serviceAvailable &&
			section === "all" &&
			view === "activity" ? (
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
