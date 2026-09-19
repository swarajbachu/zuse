import "@zuse/i18n/english/projects";
import { DitherWaveBackground } from "@repo/ui/dither";
import type {
	GithubRepoSummary,
	ProjectTemplate,
	Folder as WorkspaceFolder,
} from "@zuse/contracts";
import { RichMessage, useMessages as useUiMessages } from "@zuse/i18n/react";
import { Check, Folder, Lock, Rocket } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	addEnvironmentFolder,
	cloneEnvironmentProject,
	createEnvironmentProject,
	listEnvironmentGithubRepos,
} from "~/lib/environment-projects.ts";
import { GITHUB_LOGO_PATH } from "~/lib/github-logo";
import { getLocalEnvironmentId } from "~/lib/rpc-client.ts";
import { useEnvironmentCatalogStore } from "~/store/environment-catalog.ts";
import { EnvironmentPathBrowser } from "./environment-path-browser.tsx";
import { Button } from "./ui/button.tsx";
import { CheckboxInput } from "./ui/checkbox-input.tsx";
import {
	Dialog,
	DialogClose,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "./ui/dialog.tsx";
import { Input } from "./ui/input.tsx";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "./ui/select.tsx";
import { Spinner } from "./ui/spinner.tsx";

export type ProjectSetupMode = "choose" | "clone" | "create" | "existing";

const cloneName = (url: string): string => {
	const clean = url.trim().split(/[?#]/)[0] ?? "";
	const final = clean.split(/[/:]/).filter(Boolean).at(-1) ?? "project";
	return final.replace(/\.git$/i, "") || "project";
};

const joinPreview = (parent: string, name: string): string => {
	const clean = parent.trim().replace(/[\\/]+$/, "");
	return clean.length === 0 ? name : `${clean}/${name}`;
};

const nameValid = (name: string): boolean => /^[a-z0-9][a-z0-9-_]*$/.test(name);

export function ProjectSetupDialog({
	open,
	onOpenChange,
	initialMode = "choose",
	initialEnvironmentId,
	sourceUrl,
	sourceName,
	onComplete,
}: {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly initialMode?: ProjectSetupMode;
	readonly initialEnvironmentId?: string;
	readonly sourceUrl?: string;
	readonly sourceName?: string;
	readonly onComplete?: (
		folder: WorkspaceFolder,
		environmentId: string,
	) => void;
}) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	const entries = useEnvironmentCatalogStore((state) => state.entries);
	const connected = useMemo(
		() => entries.filter((entry) => entry.status === "connected"),
		[entries, uiMessage],
	);
	const catalogInitializing = useEnvironmentCatalogStore(
		(state) => state.initializing,
	);
	const catalogInitializationError = useEnvironmentCatalogStore(
		(state) => state.initializationError,
	);
	const initializeCatalog = useEnvironmentCatalogStore(
		(state) => state.initialize,
	);
	const retryEnvironment = useEnvironmentCatalogStore(
		(state) => state.retryEnvironment,
	);
	const [mode, setMode] = useState<ProjectSetupMode>(initialMode);
	const [environmentId, setEnvironmentId] = useState(
		initialEnvironmentId ?? getLocalEnvironmentId(),
	);
	const [parent, setParent] = useState("");
	const [parentReady, setParentReady] = useState(false);
	const [url, setUrl] = useState(sourceUrl ?? "");
	const [name, setName] = useState("");
	const [template, setTemplate] = useState<ProjectTemplate>("empty");
	const [alsoCreateGithubRepo, setAlsoCreateGithubRepo] = useState(false);
	const [repos, setRepos] = useState<ReadonlyArray<GithubRepoSummary>>([]);
	const [ghAuthenticated, setGhAuthenticated] = useState(false);
	const [loadingRepos, setLoadingRepos] = useState(false);
	const [reposError, setReposError] = useState(false);
	const [reposRequest, setReposRequest] = useState(0);
	const [submitting, setSubmitting] = useState(false);
	const [retryingConnection, setRetryingConnection] = useState(false);
	const [retryFailure, setRetryFailure] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		setMode(initialMode);
		setEnvironmentId(initialEnvironmentId ?? getLocalEnvironmentId());
		setUrl(sourceUrl ?? "");
		setParent("");
		setParentReady(false);
		setName("");
		setError(null);
		setSubmitting(false);
		setRetryingConnection(false);
		setRetryFailure(null);
		setReposError(false);
	}, [open, initialMode, initialEnvironmentId, sourceUrl]);

	useEffect(() => {
		if (
			!open ||
			connected.length === 0 ||
			(mode !== "create" && (mode !== "clone" || sourceUrl !== undefined))
		)
			return;
		let cancelled = false;
		setLoadingRepos(true);
		setReposError(false);
		void listEnvironmentGithubRepos(environmentId)
			.then((result) => {
				if (cancelled) return;
				setRepos(result.repos);
				setGhAuthenticated(result.authenticated);
			})
			.catch(() => {
				if (!cancelled) {
					setRepos([]);
					setReposError(true);
				}
			})
			.finally(() => {
				if (!cancelled) setLoadingRepos(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, mode, environmentId, sourceUrl, connected.length, reposRequest]);

	useEffect(() => {
		if (!open) return;
		if (connected.some((entry) => entry.environmentId === environmentId))
			return;
		const nextEnvironment = connected[0];
		if (nextEnvironment === undefined) return;
		setEnvironmentId(nextEnvironment.environmentId);
		setParent("");
		setParentReady(false);
	}, [open, connected, environmentId]);

	const selectedEnvironment = connected.find(
		(entry) => entry.environmentId === environmentId,
	);
	const localEnvironment = entries.find(
		(entry) => entry.connectionKind === "local",
	);
	const unavailableMessage =
		retryFailure ??
		localEnvironment?.error ??
		catalogInitializationError ??
		"Wait for the local workspace to finish loading.";
	const local = environmentId === getLocalEnvironmentId();
	const projectName =
		mode === "clone" ? (sourceName ?? cloneName(url)) : name.trim();
	const canSubmit =
		!submitting &&
		selectedEnvironment !== undefined &&
		(mode === "clone"
			? url.trim().length > 0 && parent.trim().length > 0 && parentReady
			: mode === "create"
				? nameValid(name.trim()) && parent.trim().length > 0 && parentReady
				: mode === "existing"
					? parent.trim().length > 0 && parentReady
					: false);

	const submit = async (): Promise<void> => {
		if (!canSubmit) return;
		setSubmitting(true);
		setError(null);
		try {
			const folder =
				mode === "clone"
					? await cloneEnvironmentProject(
							environmentId,
							url.trim(),
							parent.trim(),
						)
					: mode === "create"
						? await createEnvironmentProject(environmentId, {
								name: name.trim(),
								parent: parent.trim(),
								template,
								alsoCreateGithubRepo,
							})
						: await addEnvironmentFolder(environmentId, parent.trim());
			onComplete?.(folder, environmentId);
			onOpenChange(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSubmitting(false);
		}
	};

	const handleOpenChange = (next: boolean): void => {
		if (!next && submitting) return;
		onOpenChange(next);
	};

	const retryConnection = async (): Promise<void> => {
		if (retryingConnection) return;
		setRetryingConnection(true);
		setRetryFailure(null);
		try {
			if (localEnvironment === undefined) await initializeCatalog();
			else await retryEnvironment(localEnvironment.environmentId);
		} catch (cause) {
			setRetryFailure(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setRetryingConnection(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogPopup className={mode === "existing" ? "max-w-2xl" : "max-w-xl"}>
				<DialogHeader>
					<DialogTitle>
						{mode === "choose"
							? uiMessage("projects:project_setup_dialog_add_project")
							: mode === "clone"
								? uiMessage("projects:project_setup_dialog_clone", {
										value1: String(sourceName ?? "repository"),
									})
								: mode === "create"
									? uiMessage("projects:project_setup_dialog_quick_start")
									: uiMessage(
											"projects:project_setup_dialog_add_existing_folder",
										)}
					</DialogTitle>
					<DialogDescription className="sr-only">
						{uiMessage(
							"projects:project_setup_dialog_choose_a_computer_and_prepare_a_project_on_it",
						)}
					</DialogDescription>
				</DialogHeader>

				<DialogPanel>
					<div className="flex flex-col gap-4">
						<div className="flex flex-col gap-1.5 text-xs font-medium">
							<span>
								{uiMessage("projects:project_setup_dialog_create_on")}
							</span>
							<Select
								value={environmentId}
								disabled={connected.length === 0}
								onValueChange={(value) => {
									if (value !== null) {
										setEnvironmentId(value);
										setParent("");
										setParentReady(false);
										setError(null);
									}
								}}
							>
								<SelectTrigger>
									<SelectValue>
										{selectedEnvironment?.connectionKind === "local"
											? uiMessage("projects:project_setup_dialog_this_computer")
											: (selectedEnvironment?.label ?? "Choose a computer")}
									</SelectValue>
								</SelectTrigger>
								<SelectPopup>
									{connected.map((entry) => (
										<SelectItem
											key={entry.environmentId}
											value={entry.environmentId}
										>
											{entry.connectionKind === "local"
												? uiMessage(
														"projects:project_setup_dialog_this_computer",
													)
												: entry.label}
										</SelectItem>
									))}
								</SelectPopup>
							</Select>
						</div>
						{connected.length === 0 ? (
							<div
								className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-[11px]"
								role="alert"
							>
								<p className="font-medium text-foreground">
									{uiMessage(
										"projects:project_setup_dialog_this_computer_is_unavailable",
									)}
								</p>
								<p className="mt-1 text-muted-foreground">
									{unavailableMessage}
								</p>
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="mt-2 min-w-28"
									disabled={catalogInitializing || retryingConnection}
									onClick={() => {
										void retryConnection();
									}}
								>
									{catalogInitializing || retryingConnection
										? uiMessage("projects:project_setup_dialog_retrying")
										: uiMessage(
												"projects:project_setup_dialog_retry_connection",
											)}
								</Button>
							</div>
						) : null}

						{mode === "choose" ? (
							<div className="grid gap-2 sm:grid-cols-3">
								<SetupChoice
									art="quick"
									label={uiMessage("projects:project_setup_dialog_quick_start")}
									description={uiMessage(
										"projects:project_setup_dialog_create_from_a_template",
									)}
									disabled={connected.length === 0}
									onClick={() => setMode("create")}
								/>
								<SetupChoice
									art="github"
									label={uiMessage(
										"projects:project_setup_dialog_clone_repository",
									)}
									description={uiMessage(
										"projects:project_setup_dialog_clone_with_git_or_github",
									)}
									disabled={connected.length === 0}
									onClick={() => setMode("clone")}
								/>
								<SetupChoice
									art="folder"
									label={uiMessage(
										"projects:project_setup_dialog_existing_folder",
									)}
									description={uiMessage(
										"projects:project_setup_dialog_open_a_project_on_disk",
									)}
									disabled={connected.length === 0}
									onClick={() => setMode("existing")}
								/>
							</div>
						) : null}

						{mode === "clone" ? (
							<>
								{sourceUrl === undefined ? (
									<div className="flex flex-col gap-1.5 text-xs font-medium">
										<label htmlFor="project-repository-url">
											{uiMessage(
												"projects:project_setup_dialog_repository_url",
											)}
										</label>
										<Input
											id="project-repository-url"
											value={url}
											onChange={(event) => setUrl(event.currentTarget.value)}
											placeholder={uiMessage(
												"projects:project_setup_dialog_git_github_com_owner_project_git",
											)}
											spellCheck={false}
											autoFocus
										/>
									</div>
								) : (
									<div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
										<p className="text-xs font-medium">
											{sourceName ?? cloneName(sourceUrl)}
										</p>
										<p className="truncate text-[11px] text-muted-foreground">
											{sourceUrl}
										</p>
									</div>
								)}
								{sourceUrl === undefined &&
								(loadingRepos ||
									reposError ||
									repos.length > 0 ||
									!ghAuthenticated) ? (
									<div className="max-h-28 min-h-11 overflow-y-auto rounded-lg border border-border">
										{loadingRepos ? (
											<p className="p-3 text-xs text-muted-foreground">
												{uiMessage(
													"projects:project_setup_dialog_loading_repositories",
												)}
											</p>
										) : reposError ? (
											<div className="flex min-h-11 items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
												<span className="min-w-0 flex-1">
													{uiMessage(
														"projects:project_setup_dialog_github_is_unavailable_you_can_still_paste_a_repository_url",
													)}
												</span>
												<Button
													type="button"
													variant="outline"
													size="sm"
													onClick={() => setReposRequest((value) => value + 1)}
												>
													{uiMessage("common:retry")}
												</Button>
											</div>
										) : repos.length > 0 ? (
											repos.map((repo) => (
												<button
													key={repo.nameWithOwner}
													type="button"
													onClick={() => setUrl(repo.sshUrl || repo.httpsUrl)}
													className="flex min-h-9 w-full items-center gap-2 border-b border-border px-3 text-left text-xs last:border-b-0 hover:bg-accent"
												>
													<span className="min-w-0 flex-1 truncate">
														{repo.nameWithOwner}
													</span>
													{repo.isPrivate ? (
														<Lock className="size-3 text-muted-foreground" />
													) : null}
												</button>
											))
										) : (
											<p className="p-3 text-xs text-muted-foreground">
												{uiMessage(
													"projects:project_setup_dialog_enter_a_repository_url_sign_in_with_the_github_cli_on_this_computer_to",
												)}
											</p>
										)}
									</div>
								) : null}
							</>
						) : null}

						{mode === "create" ? (
							<>
								<div className="flex flex-col gap-1.5 text-xs font-medium">
									<label htmlFor="quick-project-name">
										{uiMessage("projects:project_setup_dialog_project_name")}
									</label>
									<Input
										id="quick-project-name"
										value={name}
										onChange={(event) => setName(event.currentTarget.value)}
										placeholder={uiMessage(
											"projects:project_setup_dialog_my_project",
										)}
										autoFocus
										aria-invalid={
											name.length > 0 && !nameValid(name.trim())
												? true
												: undefined
										}
									/>
									{name.length > 0 && !nameValid(name.trim()) ? (
										<span className="text-[11px] text-destructive">
											{uiMessage(
												"projects:project_setup_dialog_use_lowercase_letters_numbers_dashes_or_underscores",
											)}
										</span>
									) : null}
								</div>
								<div className="flex flex-col gap-1.5">
									<span className="text-xs font-medium">
										{uiMessage(
											"projects:project_setup_dialog_project_template",
										)}
									</span>
									<fieldset className="grid grid-cols-3 gap-2">
										<legend className="sr-only">
											{uiMessage(
												"projects:project_setup_dialog_project_template",
											)}
										</legend>
										{(["empty", "nextjs", "turborepo"] as const).map(
											(value, index) => {
												const label =
													value === "empty"
														? "Empty"
														: value === "nextjs"
															? "Next.js"
															: "Turborepo";
												const selected = template === value;
												return (
													<button
														key={value}
														type="button"
														onClick={() => setTemplate(value)}
														aria-pressed={selected}
														className={`group relative isolate flex h-16 items-center justify-center overflow-hidden rounded-lg border px-2 text-xs outline-none transition-[border-color,background-color,transform] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] ${selected ? "border-foreground/25 bg-muted/70 text-foreground" : "border-border/70 bg-muted/30 text-muted-foreground hover:border-foreground/15 hover:text-foreground"}`}
													>
														<DitherWaveBackground
															color={[154, 154, 166]}
															pixelSize={2}
															waveFrequency={2.1 + index * 0.35}
															waveAmplitude={0.3}
															colorNum={3}
															disableAnimation
															className={`absolute inset-0 -z-10 transition-opacity duration-150 ${selected ? "opacity-55" : "opacity-30 group-hover:opacity-45"}`}
														/>
														<span className="flex items-center gap-2">
															<TemplateLogo template={value} />
															<span>{label}</span>
														</span>
														{selected ? (
															<span className="absolute right-1.5 top-1.5 flex size-4 items-center justify-center rounded-full bg-background/80">
																<Check
																	aria-hidden="true"
																	className="size-2.5"
																/>
															</span>
														) : null}
													</button>
												);
											},
										)}
									</fieldset>
								</div>
								<div className="flex min-h-11 items-center gap-2 text-xs">
									<CheckboxInput
										checked={alsoCreateGithubRepo}
										onChange={setAlsoCreateGithubRepo}
										disabled={!ghAuthenticated}
									/>
									<span>
										{uiMessage(
											"projects:project_setup_dialog_also_create_a_private_github_repository",
										)}
									</span>
								</div>
							</>
						) : null}

						{mode !== "choose" && selectedEnvironment !== undefined ? (
							<div className="flex flex-col gap-1.5 text-xs font-medium">
								<span>
									{mode === "existing"
										? uiMessage("projects:project_setup_dialog_project_folder")
										: uiMessage("projects:project_setup_dialog_parent_folder")}
								</span>
								<EnvironmentPathBrowser
									environmentId={environmentId}
									value={parent}
									onChange={setParent}
									allowNativePicker={local}
									onReadyChange={setParentReady}
								/>
							</div>
						) : null}

						{mode === "clone" || mode === "create" ? (
							<p className="truncate text-[11px] text-muted-foreground">
								<RichMessage
									id="projects:project_setup_dialog_creates_sentence"
									values={{ value: joinPreview(parent, projectName) }}
									components={{ part0: <code /> }}
								/>
							</p>
						) : null}
						{error !== null ? (
							<p className="text-[11px] text-destructive" role="alert">
								{error}
							</p>
						) : null}
					</div>
				</DialogPanel>

				<DialogFooter>
					{mode !== "choose" && initialMode === "choose" ? (
						<Button
							type="button"
							variant="ghost"
							disabled={submitting}
							onClick={() => {
								setMode("choose");
								setError(null);
							}}
						>
							{uiMessage("common:back")}
						</Button>
					) : (
						<DialogClose
							render={
								<Button type="button" variant="ghost" disabled={submitting}>
									{uiMessage("common:cancel")}
								</Button>
							}
						/>
					)}
					{mode !== "choose" ? (
						<Button
							type="button"
							disabled={!canSubmit}
							onClick={() => void submit()}
							className="gap-2"
						>
							{submitting ? <Spinner className="size-3.5" /> : null}
							{submitting
								? uiMessage("projects:project_setup_dialog_working")
								: mode === "clone"
									? uiMessage("projects:project_setup_dialog_clone_project")
									: mode === "create"
										? uiMessage("projects:project_setup_dialog_create_project")
										: uiMessage("projects:project_setup_dialog_add_project")}
						</Button>
					) : null}
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}

function SetupChoice({
	art,
	label,
	description,
	disabled,
	onClick,
}: {
	readonly art: "quick" | "github" | "folder";
	readonly label: string;
	readonly description: string;
	readonly disabled: boolean;
	readonly onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className="group relative isolate flex min-h-36 flex-col justify-end overflow-hidden rounded-xl border border-border/70 bg-muted/10 p-3 text-left outline-none transition-[border-color,background-color,transform] duration-150 ease-out hover:border-foreground/20 hover:bg-muted/25 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.985] disabled:pointer-events-none disabled:opacity-50"
		>
			<DitherWaveBackground
				color={[164, 164, 176]}
				pixelSize={2}
				waveFrequency={art === "quick" ? 2.2 : art === "github" ? 2.7 : 3.1}
				waveAmplitude={0.42}
				colorNum={4}
				disableAnimation={false}
				className="absolute inset-0 -z-10 opacity-60 transition-opacity duration-150 group-hover:opacity-70"
			/>
			<span className="mb-auto flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/8 bg-background/75 text-muted-foreground shadow-sm backdrop-blur-sm transition-colors group-hover:text-foreground">
				{art === "quick" ? (
					<Rocket className="size-4" />
				) : art === "github" ? (
					<GitHubLogo className="size-4" />
				) : (
					<Folder className="size-4" />
				)}
			</span>
			<span className="flex min-w-0 flex-col gap-0.5 rounded-md bg-background/70 px-2 py-1.5 backdrop-blur-sm">
				<span className="text-xs font-medium text-foreground">{label}</span>
				<span className="text-[11px] font-normal text-muted-foreground">
					{description}
				</span>
			</span>
		</button>
	);
}

function GitHubLogo({ className }: { readonly className?: string }) {
	return (
		<svg
			aria-hidden="true"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d={GITHUB_LOGO_PATH} />
		</svg>
	);
}

function TemplateLogo({ template }: { readonly template: ProjectTemplate }) {
	if (template === "nextjs") return <NextJsLogo className="size-4" />;
	if (template === "turborepo") {
		return <TurborepoLogo className="size-4 text-[#ff1e56]" />;
	}
	return (
		<span
			aria-hidden="true"
			className="size-4 rounded-[4px] border border-current opacity-70"
		/>
	);
}

function NextJsLogo({ className }: { readonly className?: string }) {
	return (
		<svg
			aria-hidden="true"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M18.665 21.978A11.94 11.94 0 0 1 12 24C5.377 24 0 18.623 0 12S5.377 0 12 0s12 5.377 12 12c0 3.583-1.574 6.801-4.067 9.001L9.219 7.2H7.2v9.596h1.615V9.251l9.85 12.727Zm-3.332-8.533 1.6 2.061V7.2h-1.6v6.245Z" />
		</svg>
	);
}

function TurborepoLogo({ className }: { readonly className?: string }) {
	return (
		<svg
			aria-hidden="true"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M11.991 4.196A7.802 7.802 0 1 0 19.789 12a7.81 7.81 0 0 0-7.798-7.804Zm0 11.843A4.039 4.039 0 1 1 16.026 12a4.042 4.042 0 0 1-4.035 4.039Zm.653-13.125V0C18.973.339 24 5.582 24 12s-5.027 11.66-11.356 12v-2.914c4.717-.337 8.452-4.281 8.452-9.086s-3.735-8.749-8.452-9.086ZM5.113 17.959a9.08 9.08 0 0 1-2.2-5.305H0a11.95 11.95 0 0 0 3.051 7.367l2.062-2.062ZM11.337 24v-2.914a9.08 9.08 0 0 1-5.302-2.202l-2.06 2.063A11.96 11.96 0 0 0 11.337 24Z" />
		</svg>
	);
}
