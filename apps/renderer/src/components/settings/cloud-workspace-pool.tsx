import {
	CLOUD_WORKSPACE_OFFER_ID,
	type CloudCredentialConnection,
	type CloudProject,
	type CloudProviderOption,
	type CloudWorkspace,
	CloudWorkspaceOpError,
	ComposerInput,
	defaultModelFor,
	type LocalAccountDescriptor,
} from "@zuse/contracts";
import { Effect } from "effect";
import { ExternalLink, Plus } from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { cloudWorkspaceAccessPresentation } from "../../lib/cloud-workspace-access.ts";
import { formatError } from "../../lib/format-error.ts";
import { openExternal } from "../../lib/platform-capabilities.ts";
import {
	getControlPlaneRpcClient,
	getRpcClient,
} from "../../lib/rpc-client.ts";
import { switchToEnvironment } from "../../lib/switch-environment.ts";
import { useChatsStore } from "../../store/chats.ts";
import { useEnvironmentCatalogStore } from "../../store/environment-catalog.ts";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "../ui/select.tsx";
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

export function CloudWorkspacePool({
	legacySandboxSubscribed = false,
}: {
	readonly legacySandboxSubscribed?: boolean;
}) {
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
	const [repositoryUrl, setRepositoryUrl] = useState("");
	const [defaultBranch, setDefaultBranch] = useState("main");
	const [repositoryVisibility, setRepositoryVisibility] = useState<
		"public" | "private"
	>("public");
	const [selectedProvider, setSelectedProvider] = useState("");
	const [workspaceBaseRef, setWorkspaceBaseRef] = useState("");
	const [workspaceBranch, setWorkspaceBranch] = useState("");
	const [workspaceAgent, setWorkspaceAgent] = useState<"" | "claude" | "codex">(
		"",
	);
	const [workspaceModel, setWorkspaceModel] = useState("");
	const [workspacePermissions, setWorkspacePermissions] = useState("");
	const [workspaceFirstMessage, setWorkspaceFirstMessage] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [projectError, setProjectError] = useState<string | null>(null);
	const access = cloudWorkspaceAccessPresentation({
		entitlementSubscribed,
		legacySandboxSubscribed,
		serviceAvailable,
	});
	const subscribed = access.subscribed;

	const load = useCallback(async () => {
		let loadedSubscribed = legacySandboxSubscribed;
		try {
			const client = await getControlPlaneRpcClient();
			try {
				const entitlements = await Effect.runPromise(
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
				Effect.runPromise(client["cloud.providers"]()),
				Effect.runPromise(client["cloud.projects.list"]()),
				Effect.runPromise(client["cloud.workspaces.list"]({})),
				Effect.runPromise(client["cloud.credentials.list"]()),
				Effect.runPromise(client["accountAccess.detectLocal"]()),
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
				setSelectedProvider(
					(current) =>
						current ||
						providerResult.value.automaticPlacementProviderId ||
						providerResult.value.providers[0]?.providerId ||
						"",
				);
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
								legacySandboxSubscribed: false,
								serviceAvailable: false,
							}).serviceError,
			);
		} catch {
			setServiceAvailable(false);
			setError(
				cloudWorkspaceAccessPresentation({
					entitlementSubscribed: loadedSubscribed,
					legacySandboxSubscribed: false,
					serviceAvailable: false,
				}).serviceError,
			);
		}
	}, [legacySandboxSubscribed]);

	useEffect(() => {
		void load();
		const timer = window.setInterval(() => void load(), 5_000);
		return () => window.clearInterval(timer);
	}, [load]);

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
						? "Enter a repository like github.com/owner/repository and a valid default branch."
						: name.startsWith("credential:") &&
								cause instanceof CloudWorkspaceOpError &&
								cause.code === "invalid-request"
							? "No signed-in local account could be imported. Sign in on this Mac and try again."
							: name.startsWith("agent:")
								? formatError(cause)
								: "That cloud action could not be completed. Try again.";
			if (onError === undefined) setError(message);
			else onError(message);
		} finally {
			setBusy(null);
		}
	};

	const checkout = () =>
		run("checkout", async () => {
			const client = await getControlPlaneRpcClient();
			const result = await Effect.runPromise(
				client["machines.checkout"]({ offerId: CLOUD_WORKSPACE_OFFER_ID }),
			);
			await openExternal(result.checkoutUrl);
		});

	const connectProject = () => {
		setProjectError(null);
		return run(
			"connect",
			async () => {
				const client = await getControlPlaneRpcClient();
				const project = await Effect.runPromise(
					client["cloud.projects.connect"]({
						repositoryUrl: repositoryUrl.trim(),
						defaultBranch: defaultBranch.trim(),
						visibility: repositoryVisibility,
						idempotencyKey: crypto.randomUUID(),
					}),
				);
				setProjects((current) => [
					...current.filter((item) => item.projectId !== project.projectId),
					project,
				]);
				setRepositoryUrl("");
			},
			setProjectError,
		);
	};

	const connectCredential = (kind: "github" | "claude" | "codex") =>
		run(`credential:${kind}`, async () => {
			const client = await getControlPlaneRpcClient();
			const connected = await Effect.runPromise(
				client["cloud.credentials.importLocal"]({ kind }),
			);
			setCredentials((current) => [
				...current.filter((item) => item.kind !== kind),
				connected,
			]);
		});

	const disconnectCredential = (kind: "github" | "claude" | "codex") =>
		run(`credential:${kind}`, async () => {
			const client = await getControlPlaneRpcClient();
			const disconnected = await Effect.runPromise(
				client["cloud.credentials.disconnect"]({ kind }),
			);
			setCredentials((current) => [
				...current.filter((item) => item.kind !== kind),
				disconnected,
			]);
		});

	const openCloudAgent = (workspace: CloudWorkspace) =>
		run(`agent:${workspace.workspaceId}`, async () => {
			if (workspace.environmentId === undefined)
				throw new Error("The cloud workspace has not finished connecting yet.");
			if (workspaceAgent === "")
				throw new Error("Choose Claude or Codex before opening the agent.");

			const catalog = useEnvironmentCatalogStore.getState();
			await catalog.syncAccountEnvironments();
			const entry = useEnvironmentCatalogStore
				.getState()
				.entries.find(
					(candidate) => candidate.environmentId === workspace.environmentId,
				);
			if (entry?.status !== "connected")
				throw new Error(
					"The workspace runtime is ready but its desktop connection is still starting. Try again in a few seconds.",
				);

			const client = await getRpcClient(workspace.environmentId);
			const folders = await Effect.runPromise(client["workspace.list"]({}));
			const folder =
				folders.find(
					(candidate) => candidate.path === "/home/zuse/workspace",
				) ??
				(await Effect.runPromise(
					client["workspace.add"]({ path: "/home/zuse/workspace" }),
				));
			const prompt = workspaceFirstMessage.trim();
			const created = await useChatsStore
				.getState()
				.create(
					folder.id,
					workspaceAgent,
					workspaceModel.trim() || defaultModelFor(workspaceAgent),
					{
						environmentId: workspace.environmentId,
						startupInput:
							prompt.length === 0
								? undefined
								: ComposerInput.make({
										text: prompt,
										attachments: [],
										fileRefs: [],
										skillRefs: [],
									}),
					},
				);
			if (created === null)
				throw new Error(
					useChatsStore.getState().error ?? "The cloud agent could not start.",
				);
			const switched = await switchToEnvironment({
				environmentId: workspace.environmentId,
				folderId: folder.id,
				chatId: created.chatId,
				seed: created.remoteSeed,
			});
			if (!switched.switched)
				throw new Error(
					"The agent started, but the workspace disconnected before it could open. Try opening it again.",
				);
		});

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
				title="Cloud Workspace"
				description="Connect repositories once, then create an isolated sandbox and branch for each task."
				action={
					<Badge variant={subscribed ? "success" : "outline"}>
						{subscribed
							? serviceAvailable
								? "Active"
								: "Update required"
							: "$20 / month"}
					</Badge>
				}
			>
				{subscribed ? (
					<CloudSettingsRow
						title="Workspace entitlement"
						description={
							serviceAvailable
								? "Includes repository connections and metered cloud workspaces. Compute providers are selected when a workspace is created."
								: "Your paid access is intact. Update the relay before using the new workspace pool."
						}
						action={
							<Badge variant={serviceAvailable ? "success" : "warning"}>
								{serviceAvailable ? "Subscribed" : "Relay update required"}
							</Badge>
						}
					/>
				) : (
					<CloudSettingsRow
						title="Cloud workspace access"
						description="Subscribe once. You can connect multiple repositories and choose an available compute provider for each task."
						action={
							<Button
								size="xs"
								loading={busy === "checkout"}
								onClick={() => void checkout()}
							>
								<ExternalLink aria-hidden />
								Subscribe
							</Button>
						}
					/>
				)}
			</CloudSettingsGroup>

			{subscribed && serviceAvailable ? (
				<CloudSettingsGroup
					title="Cloud Access"
					description="Account-level Git and agent credentials are supplied to authorized workspaces with a versioned credential epoch."
				>
					{(["github", "claude", "codex"] as const).map((kind) => {
						const credential = credentials.find((item) => item.kind === kind);
						const localAccount = localAccounts.find(
							(item) => item.providerId === kind,
						);
						return (
							<CloudSettingsRow
								key={kind}
								title={
									kind === "github"
										? "GitHub"
										: kind === "claude"
											? "Claude"
											: "Codex"
								}
								description={
									credential?.state === "connected"
										? `${credential.accountLabel ?? "This account"} is connected to cloud and ready for new workspaces.`
										: "Connect once to use this account in new cloud workspaces."
								}
								action={
									credential?.state === "connected" ? (
										<div className="flex min-h-11 items-center gap-2">
											<Badge variant="success">Connected</Badge>
											<Button
												size="xs"
												variant="ghost"
												loading={busy === `credential:${kind}`}
												onClick={() => void disconnectCredential(kind)}
											>
												Disconnect
											</Button>
										</div>
									) : (
										<div className="flex min-h-11 items-center gap-2">
											<Badge
												variant={localAccount?.detected ? "success" : "outline"}
											>
												{localAccount?.detected
													? (localAccount.accountLabel ?? "Signed in")
													: "Sign in on this Mac"}
											</Badge>
											<Button
												size="xs"
												loading={busy === `credential:${kind}`}
												disabled={!localAccount?.detected}
												onClick={() => void connectCredential(kind)}
											>
												Import from this Mac
											</Button>
										</div>
									)
								}
							/>
						);
					})}
				</CloudSettingsGroup>
			) : null}

			{subscribed && serviceAvailable ? (
				<CloudSettingsGroup
					title="Connected projects"
					description="Connect a repository, prepare its cloud build, provision an isolated workspace, then open the selected agent inside it."
				>
					<form
						className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_9rem_8rem_auto]"
						onSubmit={(event) => {
							event.preventDefault();
							void connectProject();
						}}
					>
						<label className="sr-only" htmlFor="cloud-repository-url">
							Repository URL
						</label>
						<Input
							id="cloud-repository-url"
							value={repositoryUrl}
							onChange={(event) => setRepositoryUrl(event.target.value)}
							placeholder="https://github.com/org/repository"
							inputMode="url"
							autoComplete="off"
							spellCheck={false}
						/>
						<Select
							value={repositoryVisibility}
							onValueChange={(value) => {
								if (value === "public" || value === "private")
									setRepositoryVisibility(value);
							}}
						>
							<SelectTrigger aria-label="Repository visibility">
								<SelectValue />
							</SelectTrigger>
							<SelectPopup>
								<SelectItem value="public">Public</SelectItem>
								<SelectItem value="private">Private</SelectItem>
							</SelectPopup>
						</Select>
						<label className="sr-only" htmlFor="cloud-default-branch">
							Default branch
						</label>
						<Input
							id="cloud-default-branch"
							value={defaultBranch}
							onChange={(event) => setDefaultBranch(event.target.value)}
							placeholder="main"
							autoComplete="off"
							spellCheck={false}
						/>
						<Button
							type="submit"
							size="sm"
							loading={busy === "connect"}
							disabled={
								repositoryUrl.trim().length === 0 ||
								defaultBranch.trim().length === 0
							}
						>
							<Plus aria-hidden />
							Connect
						</Button>
					</form>
					{projectError === null ? null : (
						<p role="alert" className="px-3 pb-3 text-xs text-destructive">
							{projectError}
						</p>
					)}
					{projects.length === 0 ? (
						<CloudSettingsRow
							title="No repositories connected"
							description="Connect a repository to prepare its first cloud build."
							action={<Badge variant="outline">Empty</Badge>}
						/>
					) : (
						projects.map((project) => {
							const buildId = project.activeBuilds[selectedProvider];
							const projectWorkspaces = workspaces.filter(
								(workspace) => workspace.projectId === project.projectId,
							);
							return (
								<Fragment key={project.projectId}>
									<CloudSettingsRow
										title={project.displayName}
										description={`${project.repositoryIdentity} · ${project.defaultBranch}`}
										action={
											<div className="flex min-h-11 items-center gap-2">
												{buildId === undefined ? (
													<Button
														size="xs"
														loading={busy === `prepare:${project.projectId}`}
														disabled={selectedProvider.length === 0}
														onClick={() =>
															void run(
																`prepare:${project.projectId}`,
																async () => {
																	const client =
																		await getControlPlaneRpcClient();
																	await Effect.runPromise(
																		client["cloud.projects.prepare"]({
																			projectId: project.projectId,
																			providerId: selectedProvider,
																			idempotencyKey: crypto.randomUUID(),
																		}),
																	);
																},
															)
														}
													>
														Prepare
													</Button>
												) : (
													<Button
														size="xs"
														loading={busy === `workspace:${project.projectId}`}
														onClick={() =>
															void run(
																`workspace:${project.projectId}`,
																async () => {
																	const client =
																		await getControlPlaneRpcClient();
																	const created = await Effect.runPromise(
																		client["cloud.workspaces.create"]({
																			projectId: project.projectId,
																			providerId: selectedProvider,
																			baseRef:
																				workspaceBaseRef.trim() ||
																				`origin/${project.defaultBranch}`,
																			branch:
																				workspaceBranch.trim() || undefined,
																			agent: workspaceAgent || undefined,
																			model: workspaceModel.trim() || undefined,
																			credentialKinds:
																				workspaceAgent === ""
																					? []
																					: [workspaceAgent],
																			permissions: workspacePermissions
																				.split(",")
																				.map((item) => item.trim())
																				.filter(Boolean),
																			firstMessage:
																				workspaceFirstMessage.trim() ||
																				undefined,
																			idempotencyKey: crypto.randomUUID(),
																		}),
																	);
																	setWorkspaces((current) => [
																		...current.filter(
																			(item) =>
																				item.workspaceId !==
																				created.workspaceId,
																		),
																		created,
																	]);
																},
															)
														}
													>
														New workspace
													</Button>
												)}
												<Badge
													variant={
														project.state === "ready"
															? "success"
															: project.state === "failed"
																? "error"
																: "warning"
													}
												>
													{project.state}
												</Badge>
											</div>
										}
									/>
									{projectWorkspaces.map((workspace) => (
										<CloudSettingsRow
											key={workspace.workspaceId}
											title={`↳ ${workspace.branch}`}
											description={`${providers.find((provider) => provider.providerId === workspace.providerId)?.displayName ?? workspace.providerId} · ${workspace.statusCode}`}
											action={
												<div className="flex min-h-11 items-center gap-2">
													<Badge variant={stateVariant(workspace.state)}>
														{workspace.state}
													</Badge>
													{workspace.state === "ready" ? (
														<>
															<Button
																size="xs"
																loading={
																	busy === `agent:${workspace.workspaceId}`
																}
																disabled={workspaceAgent === ""}
																onClick={() => void openCloudAgent(workspace)}
															>
																Open agent
															</Button>
															<Button
																size="xs"
																variant="ghost"
																onClick={() =>
																	void run(
																		`pause:${workspace.workspaceId}`,
																		async () => {
																			const client =
																				await getControlPlaneRpcClient();
																			await Effect.runPromise(
																				client["cloud.workspaces.pause"]({
																					workspaceId: workspace.workspaceId,
																				}),
																			);
																		},
																	)
																}
															>
																Pause
															</Button>
														</>
													) : workspace.state === "paused" ? (
														<Button
															size="xs"
															variant="ghost"
															onClick={() =>
																void run(
																	`resume:${workspace.workspaceId}`,
																	async () => {
																		const client =
																			await getControlPlaneRpcClient();
																		await Effect.runPromise(
																			client["cloud.workspaces.resume"]({
																				workspaceId: workspace.workspaceId,
																			}),
																		);
																	},
																)
															}
														>
															Resume
														</Button>
													) : null}
												</div>
											}
										/>
									))}
								</Fragment>
							);
						})
					)}
					{providers.length > 0 ? (
						<div className="grid gap-2 p-3 pt-0 sm:grid-cols-2">
							<label className="block space-y-1" htmlFor="cloud-provider">
								<span className="text-[11px] font-medium">
									Compute provider
								</span>
								<Select
									value={selectedProvider}
									onValueChange={(value) => {
										if (value !== null) setSelectedProvider(value);
									}}
								>
									<SelectTrigger id="cloud-provider" className="min-h-11">
										<SelectValue />
									</SelectTrigger>
									<SelectPopup>
										{providers.map((provider) => (
											<SelectItem
												key={provider.providerId}
												value={provider.providerId}
											>
												{provider.displayName}
											</SelectItem>
										))}
									</SelectPopup>
								</Select>
							</label>
							<Input
								value={workspaceBaseRef}
								onChange={(event) => setWorkspaceBaseRef(event.target.value)}
								placeholder="Base branch or PR (default branch)"
								aria-label="Workspace base reference"
							/>
							<Input
								value={workspaceBranch}
								onChange={(event) => setWorkspaceBranch(event.target.value)}
								placeholder="Task branch (automatic)"
								aria-label="Workspace branch"
							/>
							<Select
								value={workspaceAgent}
								onValueChange={(value) => {
									if (value === "" || value === "claude" || value === "codex")
										setWorkspaceAgent(value);
								}}
							>
								<SelectTrigger
									aria-label="Workspace agent"
									className="min-h-11"
								>
									<SelectValue placeholder="Choose agent" />
								</SelectTrigger>
								<SelectPopup>
									<SelectItem value="claude">Claude</SelectItem>
									<SelectItem value="codex">Codex</SelectItem>
								</SelectPopup>
							</Select>
							<Input
								value={workspaceModel}
								onChange={(event) => setWorkspaceModel(event.target.value)}
								placeholder="Model (agent default)"
								aria-label="Workspace model"
							/>
							<Input
								value={workspacePermissions}
								onChange={(event) =>
									setWorkspacePermissions(event.target.value)
								}
								placeholder="Permissions, comma separated"
								aria-label="Workspace permissions"
							/>
							<Input
								value={workspaceFirstMessage}
								onChange={(event) =>
									setWorkspaceFirstMessage(event.target.value)
								}
								placeholder="First message (optional)"
								aria-label="Workspace first message"
							/>
						</div>
					) : null}
				</CloudSettingsGroup>
			) : null}
		</>
	);
}
