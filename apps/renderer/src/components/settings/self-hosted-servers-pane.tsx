import "@zuse/i18n/english/settings";
import type {
	DiscoveredSshHost,
	RemoteEnvironmentProfile,
	SelfHostedGithubLoginState,
	SelfHostedHostHealth,
	SelfHostedPreflight,
	SelfHostedSetupEvent,
	SshEnvironmentTarget,
} from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Effect } from "effect";
import {
	Check,
	Copy,
	ExternalLink,
	Plus,
	RotateCw,
	Server,
	Trash2,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { downloadBlob } from "../../lib/download-blob.ts";
import { runtimeOperationClient } from "../../lib/runtime-operation-client.ts";
import { useEnvironmentCatalogStore } from "../../store/environment-catalog.ts";
import { ProjectSetupDialog } from "../project-setup-dialog.tsx";
import { Button } from "../ui/button.tsx";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPopup,
	DialogTitle,
} from "../ui/dialog.tsx";
import { Input } from "../ui/input.tsx";
import { Spinner } from "../ui/spinner.tsx";

const blankTarget = (): SshEnvironmentTarget => ({
	alias: "",
	hostname: "",
	username: null,
	port: null,
});

const errorText = (cause: unknown): string =>
	cause instanceof Error
		? cause.message
		: "The operation could not be completed.";

const targetLabel = (profile: RemoteEnvironmentProfile): string => {
	const destination = profile.target.username
		? `${profile.target.username}@${profile.target.hostname}`
		: profile.target.hostname;
	return profile.target.port === null
		? destination
		: `${destination}:${profile.target.port}`;
};

export function SelfHostedServersPane() {
	useUiMessages(["settings"]);
	const entries = useEnvironmentCatalogStore((state) => state.entries);
	const initialize = useEnvironmentCatalogStore((state) => state.initialize);
	const syncAccountEnvironments = useEnvironmentCatalogStore(
		(state) => state.syncAccountEnvironments,
	);
	const activate = useEnvironmentCatalogStore((state) => state.activate);
	const retryEnvironment = useEnvironmentCatalogStore(
		(state) => state.retryEnvironment,
	);
	const hideApiEnvironment = useEnvironmentCatalogStore(
		(state) => state.hideApiEnvironment,
	);
	const [profiles, setProfiles] = useState<
		ReadonlyArray<RemoteEnvironmentProfile>
	>([]);
	const [suggestions, setSuggestions] = useState<
		ReadonlyArray<DiscoveredSshHost>
	>([]);
	const [setupOpen, setSetupOpen] = useState(false);
	const [projectSetup, setProjectSetup] = useState<{
		readonly environmentId: string;
		readonly mode: "clone" | "create" | "existing";
	} | null>(null);
	const [target, setTarget] = useState<SshEnvironmentTarget>(blankTarget);
	const [label, setLabel] = useState("");
	const [operationId, setOperationId] = useState<string | null>(null);
	const operationIdRef = useRef<string | null>(null);
	const [progress, setProgress] = useState<SelfHostedSetupEvent | null>(null);
	const [lastPreflight, setLastPreflight] =
		useState<SelfHostedPreflight | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
	const [pendingRuntimeAction, setPendingRuntimeAction] = useState<
		string | null
	>(null);
	const [healthByEnvironment, setHealthByEnvironment] = useState<
		Readonly<Record<string, SelfHostedHostHealth>>
	>({});
	const [githubByEnvironment, setGithubByEnvironment] = useState<
		Readonly<Record<string, SelfHostedGithubLoginState>>
	>({});

	const refreshProfiles = async (): Promise<void> => {
		const next = await window.zuse?.ssh?.listProfiles();
		setProfiles(next ?? []);
	};

	useEffect(() => {
		void initialize();
		void refreshProfiles().catch((cause) => setError(errorText(cause)));
	}, [initialize]);

	useEffect(() => {
		return (
			window.zuse?.ssh?.onSelfHostedSetupEvent((event) => {
				if (event.operationId !== operationIdRef.current) return;
				setProgress(event);
				if (event.preflight !== undefined) setLastPreflight(event.preflight);
				if (event.phase === "ready") {
					void refreshProfiles();
					void syncAccountEnvironments();
				}
			}) ?? (() => undefined)
		);
	}, [syncAccountEnvironments]);

	const accountProfiles = useMemo(
		() =>
			profiles.filter((profile) => profile.connectionMode === "account-linked"),
		[profiles],
	);
	const localProfiles = useMemo(
		() =>
			profiles.filter((profile) => profile.connectionMode !== "account-linked"),
		[profiles],
	);
	const catalogByEnvironment = useMemo(
		() => new Map(entries.map((entry) => [entry.environmentId, entry])),
		[entries],
	);

	useEffect(() => {
		let cancelled = false;
		for (const profile of accountProfiles) {
			const entry = catalogByEnvironment.get(profile.environmentId);
			if (entry?.status !== "connected") continue;
			void runtimeOperationClient(profile.environmentId)
				.then(async (client) => {
					const [health, github] = await Promise.all([
						Effect.runPromise(client["host.status"]()),
						Effect.runPromise(client["host.github.status"]()),
					]);
					return { health, github };
				})
				.then(({ health, github }) => {
					if (!cancelled) {
						setHealthByEnvironment((current) => ({
							...current,
							[profile.environmentId]: health,
						}));
						setGithubByEnvironment((current) => ({
							...current,
							[profile.environmentId]: github,
						}));
					}
				})
				.catch(() => undefined);
		}
		return () => {
			cancelled = true;
		};
	}, [accountProfiles, catalogByEnvironment]);

	useEffect(() => {
		const active = Object.entries(githubByEnvironment).filter(
			([, state]) =>
				state.state === "authorizing" && state.operationId !== undefined,
		);
		if (active.length === 0) return;
		const timer = setInterval(() => {
			for (const [environmentId, state] of active) {
				if (state.operationId === undefined) continue;
				void runtimeOperationClient(environmentId)
					.then((client) =>
						Effect.runPromise(
							client["host.github.loginPoll"]({
								operationId: state.operationId as string,
							}),
						),
					)
					.then((next) =>
						setGithubByEnvironment((current) => ({
							...current,
							[environmentId]: next,
						})),
					)
					.catch(() => undefined);
			}
		}, 1_500);
		return () => clearInterval(timer);
	}, [githubByEnvironment]);

	const openSetup = (profile?: RemoteEnvironmentProfile): void => {
		setTarget(profile?.target ?? blankTarget());
		setLabel(profile?.label ?? "");
		setOperationId(null);
		operationIdRef.current = null;
		setProgress(null);
		setLastPreflight(null);
		setError(null);
		setSetupOpen(true);
		void window.zuse?.ssh
			?.discoverHosts()
			.then(setSuggestions)
			.catch(() => setSuggestions([]));
	};

	const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
		event.preventDefault();
		if (operationId !== null) return;
		const hostname = target.hostname.trim();
		if (hostname.length === 0) {
			setError("Enter an SSH host name or choose one from your SSH config.");
			return;
		}
		const id = crypto.randomUUID();
		operationIdRef.current = id;
		setOperationId(id);
		setProgress(null);
		setLastPreflight(null);
		setError(null);
		try {
			await window.zuse?.ssh?.startSelfHostedSetup({
				operationId: id,
				label: label.trim() || target.alias.trim() || hostname,
				target: {
					...target,
					alias: target.alias.trim() || hostname,
					hostname,
				},
			});
		} catch (cause) {
			operationIdRef.current = null;
			setOperationId(null);
			setError(errorText(cause));
		}
	};

	const removeLocalProfile = async (profileId: string): Promise<void> => {
		setError(null);
		try {
			await window.zuse?.ssh?.removeProfile(profileId);
			await refreshProfiles();
		} catch (cause) {
			setError(errorText(cause));
		}
	};

	const detachServer = async (
		profile: RemoteEnvironmentProfile,
	): Promise<void> => {
		setError(null);
		try {
			const client = await runtimeOperationClient(profile.environmentId);
			await Effect.runPromise(client["host.detach"]());
			await window.zuse?.ssh?.removeProfile(profile.profileId);
			await hideApiEnvironment(profile.environmentId);
			await refreshProfiles();
			setPendingRemoval(null);
		} catch (cause) {
			setError(errorText(cause));
		}
	};

	const startGithubLogin = async (environmentId: string): Promise<void> => {
		setError(null);
		try {
			const client = await runtimeOperationClient(environmentId);
			const state = await Effect.runPromise(client["host.github.loginStart"]());
			setGithubByEnvironment((current) => ({
				...current,
				[environmentId]: state,
			}));
		} catch (cause) {
			setError(errorText(cause));
		}
	};

	const logoutGithub = async (environmentId: string): Promise<void> => {
		setError(null);
		try {
			const client = await runtimeOperationClient(environmentId);
			const state = await Effect.runPromise(client["host.github.logout"]());
			setGithubByEnvironment((current) => ({
				...current,
				[environmentId]: state,
			}));
		} catch (cause) {
			setError(errorText(cause));
		}
	};

	const runRuntimeAction = async (
		environmentId: string,
		action: "restart" | "update",
	): Promise<void> => {
		const key = `${environmentId}:${action}`;
		if (pendingRuntimeAction !== key) {
			setPendingRuntimeAction(key);
			return;
		}
		setError(null);
		try {
			const client = await runtimeOperationClient(environmentId);
			if (action === "restart") {
				await Effect.runPromise(
					client["host.runtime.restart"]({ force: true }),
				);
			} else {
				await Effect.runPromise(client["host.runtime.update"]({ force: true }));
			}
			setPendingRuntimeAction(null);
		} catch (cause) {
			setError(errorText(cause));
		}
	};

	const downloadDiagnostics = async (environmentId: string): Promise<void> => {
		setError(null);
		try {
			const client = await runtimeOperationClient(environmentId);
			const bundle = await Effect.runPromise(client["host.diagnostics"]());
			downloadBlob(
				new Blob([bundle.content], { type: "application/json" }),
				bundle.fileName,
			);
		} catch (cause) {
			setError(errorText(cause));
		}
	};

	return (
		<section className="flex flex-col gap-4 text-xs">
			<div className="flex items-center justify-between gap-3 rounded-lg bg-muted/25 px-3 py-2.5">
				<div className="min-w-0">
					<div className="font-medium">
						{uiMessage("settings:self_hosted_your_vps_connected_to_zuse")}
					</div>
					<div className="mt-0.5 text-[11px] text-muted-foreground">
						{uiMessage(
							"settings:self_hosted_zuse_manages_its_runtime_and_projects_your_vps_provider_keeps_control_of_power_snapshots_and_billing",
						)}
					</div>
				</div>
				<Button className="h-7 shrink-0" size="sm" onClick={() => openSetup()}>
					<Plus className="size-3.5" />
					{uiMessage("settings:self_hosted_add_server")}
				</Button>
			</div>

			{error !== null ? (
				<div
					role="alert"
					className="rounded-md bg-destructive/10 px-3 py-2 text-destructive"
				>
					{error}
				</div>
			) : null}

			<div className="space-y-2">
				{accountProfiles.length === 0 ? (
					<div className="py-8 text-center text-muted-foreground">
						<Server className="mx-auto mb-2 size-6 opacity-50" />
						{uiMessage("settings:self_hosted_no_self_hosted_servers_yet")}
					</div>
				) : (
					accountProfiles.map((profile) => {
						const entry = catalogByEnvironment.get(profile.environmentId);
						const status = entry?.status ?? "offline";
						const health = healthByEnvironment[profile.environmentId];
						const github = githubByEnvironment[profile.environmentId];
						const restartKey = `${profile.environmentId}:restart`;
						const updateKey = `${profile.environmentId}:update`;
						return (
							<div
								key={profile.profileId}
								className="rounded-lg bg-muted/20 px-3 py-2.5"
							>
								<div className="flex items-start gap-3">
									<div className="mt-0.5 rounded-md bg-muted p-1.5">
										<Server className="size-4" />
									</div>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className="truncate font-medium">
												{profile.label}
											</span>
											<span className="text-[10px] text-muted-foreground">
												{status}
											</span>
										</div>
										<div className="truncate text-[11px] text-muted-foreground">
											{targetLabel(profile)}
										</div>
										{health !== undefined ? (
											<div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
												<span>
													{health.osId} {health.osVersion} ·{" "}
													{health.architecture}
												</span>
												<span>
													{uiMessage("settings:self_hosted_resources", {
														cores: health.cpuCores,
														memory: Math.round(
															health.memoryTotalBytes / 1_073_741_824,
														),
													})}
												</span>
												<span>
													{uiMessage("settings:self_hosted_free_disk", {
														disk: Math.round(
															health.diskAvailableBytes / 1_073_741_824,
														),
													})}
												</span>
												<span>
													{uiMessage("settings:self_hosted_zuse")}{" "}
													{health.zuseVersion}
												</span>
											</div>
										) : null}
										{github?.state === "authorizing" ? (
											<div className="mt-2 flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-[11px]">
												<Spinner />
												<span>
													{github.verificationCode !== undefined
														? uiMessage(
																"settings:self_hosted_authorize_github_code",
																{ code: github.verificationCode },
															)
														: uiMessage(
																"settings:self_hosted_authorize_github",
															)}
												</span>
												{github.verificationCode !== undefined ? (
													<Button
														size="xs"
														variant="ghost"
														onClick={() =>
															void window.zuse?.app?.copyText?.(
																github.verificationCode ?? "",
															)
														}
													>
														<Copy className="size-3" />
														{uiMessage("settings:self_hosted_copy")}
													</Button>
												) : null}
												<Button
													size="xs"
													variant="ghost"
													onClick={() =>
														window.zuse?.app?.openExternal(
															github.verificationUrl ??
																"https://github.com/login/device",
														)
													}
												>
													<ExternalLink className="size-3" />
													{uiMessage("settings:self_hosted_open")}
												</Button>
											</div>
										) : null}
									</div>
									<div className="flex flex-wrap justify-end gap-1">
										<Button
											size="xs"
											variant="outline"
											disabled={entry === undefined}
											onClick={() => void activate(profile.environmentId)}
										>
											{uiMessage("settings:self_hosted_open_server")}
										</Button>
										<Button
											size="xs"
											variant="outline"
											disabled={entry === undefined || status !== "connected"}
											onClick={() =>
												setProjectSetup({
													environmentId: profile.environmentId,
													mode: "clone",
												})
											}
										>
											{uiMessage("settings:self_hosted_clone_repository")}
										</Button>
										<Button
											size="xs"
											variant="outline"
											disabled={entry === undefined || status !== "connected"}
											onClick={() =>
												setProjectSetup({
													environmentId: profile.environmentId,
													mode: "existing",
												})
											}
										>
											{uiMessage("settings:self_hosted_add_existing_folder")}
										</Button>
										<Button
											size="xs"
											variant="outline"
											disabled={entry === undefined || status !== "connected"}
											onClick={() =>
												setProjectSetup({
													environmentId: profile.environmentId,
													mode: "create",
												})
											}
										>
											{uiMessage("settings:self_hosted_create_project")}
										</Button>
										{entry !== undefined && status !== "connected" ? (
											<Button
												size="icon-xs"
												variant="ghost"
												aria-label={uiMessage(
													"settings:self_hosted_reconnect",
													{ name: profile.label },
												)}
												onClick={() =>
													void retryEnvironment(profile.environmentId)
												}
											>
												<RotateCw className="size-3.5" />
											</Button>
										) : null}
										{status === "connected" ? (
											<Button
												size="xs"
												variant={
													pendingRemoval === profile.profileId
														? "destructive"
														: "ghost"
												}
												onClick={() => {
													if (pendingRemoval === profile.profileId)
														void detachServer(profile);
													else setPendingRemoval(profile.profileId);
												}}
											>
												{pendingRemoval === profile.profileId
													? uiMessage("settings:self_hosted_confirm_remove")
													: uiMessage("settings:self_hosted_remove_from_zuse")}
											</Button>
										) : null}
										{status === "connected" ? (
											<Button
												size="xs"
												variant="ghost"
												onClick={() =>
													void downloadDiagnostics(profile.environmentId)
												}
											>
												{uiMessage("settings:self_hosted_download_diagnostics")}
											</Button>
										) : null}
										{status === "connected" &&
										github?.state !== "authorizing" ? (
											<Button
												size="xs"
												variant="ghost"
												onClick={() =>
													github?.state === "connected"
														? void logoutGithub(profile.environmentId)
														: void startGithubLogin(profile.environmentId)
												}
											>
												{github?.state === "connected"
													? uiMessage("settings:self_hosted_disconnect_github")
													: uiMessage("settings:self_hosted_connect_github")}
											</Button>
										) : null}
										{status === "connected" ? (
											<>
												<Button
													size="xs"
													variant={
														pendingRuntimeAction === updateKey
															? "destructive"
															: "ghost"
													}
													onClick={() =>
														void runRuntimeAction(
															profile.environmentId,
															"update",
														)
													}
												>
													{pendingRuntimeAction === updateKey
														? uiMessage("settings:self_hosted_confirm_update")
														: uiMessage("settings:self_hosted_update_zuse")}
												</Button>
												<Button
													size="xs"
													variant={
														pendingRuntimeAction === restartKey
															? "destructive"
															: "ghost"
													}
													onClick={() =>
														void runRuntimeAction(
															profile.environmentId,
															"restart",
														)
													}
												>
													{pendingRuntimeAction === restartKey
														? uiMessage("settings:self_hosted_confirm_restart")
														: uiMessage("settings:self_hosted_restart_runtime")}
												</Button>
											</>
										) : null}
									</div>
								</div>
							</div>
						);
					})
				)}
			</div>

			{localProfiles.length > 0 ? (
				<div className="space-y-2 border-t border-border/40 pt-3">
					<div className="font-medium">
						{uiMessage("settings:self_hosted_local_only_ssh_profiles")}
					</div>
					<div className="text-[11px] text-muted-foreground">
						{uiMessage(
							"settings:self_hosted_these_stay_on_this_desktop_until_you_explicitly_enroll_them",
						)}
					</div>
					{localProfiles.map((profile) => (
						<div
							key={profile.profileId}
							className="flex items-center gap-2 rounded-md bg-muted/20 px-3 py-2"
						>
							<div className="min-w-0 flex-1">
								<div className="truncate font-medium">{profile.label}</div>
								<div className="truncate text-[11px] text-muted-foreground">
									{targetLabel(profile)}
								</div>
							</div>
							<Button
								size="xs"
								variant="outline"
								onClick={() => openSetup(profile)}
							>
								{uiMessage("settings:self_hosted_make_available_everywhere")}
							</Button>
							<Button
								size="icon-xs"
								variant="ghost"
								aria-label={uiMessage("settings:self_hosted_forget", {
									name: profile.label,
								})}
								onClick={() => void removeLocalProfile(profile.profileId)}
							>
								<Trash2 className="size-3.5" />
							</Button>
						</div>
					))}
				</div>
			) : null}

			<Dialog
				open={setupOpen}
				onOpenChange={(open) => {
					if (
						!open &&
						operationId !== null &&
						progress?.phase !== "ready" &&
						progress?.phase !== "failed" &&
						progress?.phase !== "cancelled"
					)
						return;
					setSetupOpen(open);
				}}
			>
				<DialogPopup className="max-w-lg">
					<DialogHeader>
						<DialogTitle>
							{uiMessage("settings:self_hosted_add_a_self_hosted_server")}
						</DialogTitle>
						<DialogDescription>
							{uiMessage(
								"settings:self_hosted_zuse_uses_your_existing_openssh_config_keys_and_agent_password_login_is_not_supported",
							)}
						</DialogDescription>
					</DialogHeader>
					<form onSubmit={(event) => void submit(event)}>
						<div className="space-y-3 px-4 pb-3">
							{operationId === null ? (
								<>
									{suggestions.length > 0 ? (
										<div>
											<div className="mb-1 text-[11px] font-medium text-muted-foreground">
												{uiMessage("settings:self_hosted_ssh_config")}
											</div>
											<div className="flex flex-wrap gap-1">
												{suggestions.map((host) => (
													<Button
														key={host.alias}
														type="button"
														size="xs"
														variant="outline"
														onClick={() => {
															setTarget({
																alias: host.alias,
																hostname: host.hostname,
																username: host.username,
																port: host.port,
															});
															setLabel(host.displayName);
														}}
													>
														{host.displayName}
													</Button>
												))}
											</div>
										</div>
									) : null}
									<div className="grid grid-cols-2 gap-2">
										<label htmlFor="self-hosted-host" className="space-y-1">
											<span className="text-[11px] text-muted-foreground">
												{uiMessage("settings:self_hosted_host_or_ssh_alias")}
											</span>
											<Input
												id="self-hosted-host"
												className="h-7"
												value={target.hostname}
												onChange={(event) =>
													setTarget((current) => ({
														...current,
														hostname: event.target.value,
														alias: current.alias || event.target.value,
													}))
												}
											/>
										</label>
										<label htmlFor="self-hosted-label" className="space-y-1">
											<span className="text-[11px] text-muted-foreground">
												{uiMessage("settings:self_hosted_display_name")}
											</span>
											<Input
												id="self-hosted-label"
												className="h-7"
												value={label}
												onChange={(event) => setLabel(event.target.value)}
											/>
										</label>
									</div>
									<div className="grid grid-cols-2 gap-2">
										<label htmlFor="self-hosted-user" className="space-y-1">
											<span className="text-[11px] text-muted-foreground">
												{uiMessage("settings:self_hosted_ssh_user_optional")}
											</span>
											<Input
												id="self-hosted-user"
												className="h-7"
												value={target.username ?? ""}
												onChange={(event) =>
													setTarget((current) => ({
														...current,
														username: event.target.value || null,
													}))
												}
											/>
										</label>
										<label htmlFor="self-hosted-port" className="space-y-1">
											<span className="text-[11px] text-muted-foreground">
												{uiMessage("settings:self_hosted_port_optional")}
											</span>
											<Input
												id="self-hosted-port"
												className="h-7"
												inputMode="numeric"
												value={target.port ?? ""}
												onChange={(event) =>
													setTarget((current) => ({
														...current,
														port:
															event.target.value === ""
																? null
																: Number(event.target.value),
													}))
												}
											/>
										</label>
									</div>
								</>
							) : (
								<SetupProgress event={progress} preflight={lastPreflight} />
							)}
							{error !== null ? (
								<div role="alert" className="text-destructive">
									{error}
								</div>
							) : null}
						</div>
						<DialogFooter>
							{operationId !== null &&
							progress?.phase !== "ready" &&
							progress?.phase !== "failed" &&
							progress?.phase !== "cancelled" ? (
								<Button
									type="button"
									variant="ghost"
									onClick={() =>
										void window.zuse?.ssh?.cancelSelfHostedSetup(operationId)
									}
								>
									{uiMessage("settings:self_hosted_cancel_setup")}
								</Button>
							) : null}
							{operationId === null ? (
								<Button type="submit">
									{uiMessage("settings:self_hosted_verify_and_install")}
								</Button>
							) : null}
							{progress?.phase === "ready" ||
							progress?.phase === "failed" ||
							progress?.phase === "cancelled" ? (
								<Button
									type="button"
									onClick={() => {
										if (progress.phase === "ready") setSetupOpen(false);
										else {
											setOperationId(null);
											operationIdRef.current = null;
											setProgress(null);
											setLastPreflight(null);
										}
									}}
								>
									{progress.phase === "ready"
										? uiMessage("settings:self_hosted_done")
										: uiMessage("settings:self_hosted_try_again")}
								</Button>
							) : null}
						</DialogFooter>
					</form>
				</DialogPopup>
			</Dialog>

			{projectSetup !== null ? (
				<ProjectSetupDialog
					open
					initialMode={projectSetup.mode}
					initialEnvironmentId={projectSetup.environmentId}
					initialParent="~/zuse"
					onOpenChange={(open) => {
						if (!open) setProjectSetup(null);
					}}
				/>
			) : null}
		</section>
	);
}

function SetupProgress({
	event,
	preflight,
}: {
	readonly event: SelfHostedSetupEvent | null;
	readonly preflight: SelfHostedPreflight | null;
}) {
	if (event === null)
		return (
			<div className="flex items-center gap-2 py-6 text-muted-foreground">
				<Spinner />
				{uiMessage("settings:self_hosted_starting_setup")}
			</div>
		);
	const finished = event.phase === "ready";
	const details = event.preflight ?? preflight;
	return (
		<div className="space-y-3 py-2">
			<div className="flex items-center gap-2">
				{finished ? (
					<Check className="size-4 text-emerald-500" />
				) : event.phase === "failed" || event.phase === "cancelled" ? null : (
					<Spinner />
				)}
				<span className="font-medium">{event.message}</span>
			</div>
			{details !== null ? (
				<div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-muted/30 px-3 py-2 text-[11px]">
					<span>{uiMessage("settings:self_hosted_system")}</span>
					<span>
						{details.osId} {details.osVersion}
					</span>
					<span>{uiMessage("settings:self_hosted_architecture")}</span>
					<span>{details.architecture}</span>
					<span>{uiMessage("settings:self_hosted_disk_available")}</span>
					<span>
						{Math.round(details.availableDiskBytes / 1_073_741_824)}
						{uiMessage("settings:self_hosted_gb")}
					</span>
					{details.manualCommand !== null ? (
						<>
							<span>{uiMessage("settings:self_hosted_one_time_repair")}</span>
							<Button
								type="button"
								size="xs"
								variant="outline"
								onClick={() =>
									void window.zuse?.app?.copyText?.(details.manualCommand ?? "")
								}
							>
								<Copy className="size-3" />
								{uiMessage("settings:self_hosted_copy_command")}
							</Button>
						</>
					) : null}
				</div>
			) : null}
			{event.userCode !== undefined && event.verificationUri !== undefined ? (
				<div className="rounded-md bg-muted/30 px-3 py-2">
					<div className="text-[11px] text-muted-foreground">
						{uiMessage("settings:self_hosted_authorize_this_server_with_code")}
					</div>
					<div className="my-2 font-mono text-lg tracking-[0.18em]">
						{event.userCode}
					</div>
					<div className="flex gap-1">
						<Button
							type="button"
							size="xs"
							variant="outline"
							onClick={() =>
								void window.zuse?.app?.copyText?.(event.userCode ?? "")
							}
						>
							<Copy className="size-3" />
							{uiMessage("settings:self_hosted_copy_code")}
						</Button>
						<Button
							type="button"
							size="xs"
							onClick={() =>
								window.zuse?.app?.openExternal(event.verificationUri ?? "")
							}
						>
							<ExternalLink className="size-3" />
							{uiMessage("settings:self_hosted_open_authorization")}
						</Button>
					</div>
				</div>
			) : null}
			{event.errorCode !== undefined ? (
				<div role="alert" className="text-destructive">
					{uiMessage("settings:self_hosted_setup_stopped")}
					{event.errorCode}
				</div>
			) : null}
		</div>
	);
}
