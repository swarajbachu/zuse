import type {
	GithubRepoSummary,
	ProjectTemplate,
	Folder as WorkspaceFolder,
} from "@zuse/contracts";
import { FilePlus2, Folder, GitFork, Lock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
	addEnvironmentFolder,
	cloneEnvironmentProject,
	createEnvironmentProject,
	listEnvironmentGithubRepos,
} from "~/lib/environment-projects.ts";
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
	const entries = useEnvironmentCatalogStore((state) => state.entries);
	const connected = useMemo(
		() => entries.filter((entry) => entry.status === "connected"),
		[entries],
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
	const [submitting, setSubmitting] = useState(false);
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
	}, [open, initialMode, initialEnvironmentId, sourceUrl]);

	useEffect(() => {
		if (
			!open ||
			(mode !== "create" && (mode !== "clone" || sourceUrl !== undefined))
		)
			return;
		let cancelled = false;
		setLoadingRepos(true);
		void listEnvironmentGithubRepos(environmentId)
			.then((result) => {
				if (cancelled) return;
				setRepos(result.repos);
				setGhAuthenticated(result.authenticated);
			})
			.catch(() => {
				if (!cancelled) {
					setRepos([]);
					setGhAuthenticated(false);
				}
			})
			.finally(() => {
				if (!cancelled) setLoadingRepos(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, mode, environmentId, sourceUrl]);

	const selectedEnvironment = connected.find(
		(entry) => entry.environmentId === environmentId,
	);
	const local = environmentId === getLocalEnvironmentId();
	const projectName =
		mode === "clone" ? (sourceName ?? cloneName(url)) : name.trim();
	const canSubmit =
		!submitting &&
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

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogPopup className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						{mode === "choose"
							? "Add project"
							: mode === "clone"
								? `Clone ${sourceName ?? "repository"}`
								: mode === "create"
									? "Quick start"
									: "Add existing folder"}
					</DialogTitle>
					<DialogDescription className="sr-only">
						Choose a computer and prepare a project on it.
					</DialogDescription>
				</DialogHeader>

				<DialogPanel>
					<div className="flex flex-col gap-4">
						<div className="flex flex-col gap-1.5 text-xs font-medium">
							<span>Create on</span>
							<Select
								value={environmentId}
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
											? "This computer"
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
												? "This computer"
												: entry.label}
										</SelectItem>
									))}
								</SelectPopup>
							</Select>
						</div>

						{mode === "choose" ? (
							<div className="grid gap-2 sm:grid-cols-3">
								<SetupChoice
									icon={GitFork}
									label="Clone repository"
									onClick={() => setMode("clone")}
								/>
								<SetupChoice
									icon={FilePlus2}
									label="Quick start"
									onClick={() => setMode("create")}
								/>
								<SetupChoice
									icon={Folder}
									label="Existing folder"
									onClick={() => setMode("existing")}
								/>
							</div>
						) : null}

						{mode === "clone" ? (
							<>
								{sourceUrl === undefined ? (
									<div className="flex flex-col gap-1.5 text-xs font-medium">
										<label htmlFor="project-repository-url">
											Repository URL
										</label>
										<Input
											id="project-repository-url"
											value={url}
											onChange={(event) => setUrl(event.currentTarget.value)}
											placeholder="git@github.com:owner/project.git"
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
								(loadingRepos || repos.length > 0 || !ghAuthenticated) ? (
									<div className="max-h-28 overflow-y-auto rounded-lg border border-border">
										{loadingRepos ? (
											<p className="p-3 text-xs text-muted-foreground">
												Loading repositories…
											</p>
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
												Enter a repository URL. Sign in with the GitHub CLI on
												this computer to see recent repositories.
											</p>
										)}
									</div>
								) : null}
							</>
						) : null}

						{mode === "create" ? (
							<>
								<div className="flex flex-col gap-1.5 text-xs font-medium">
									<label htmlFor="quick-project-name">Project name</label>
									<Input
										id="quick-project-name"
										value={name}
										onChange={(event) => setName(event.currentTarget.value)}
										placeholder="my-project"
										autoFocus
										aria-invalid={
											name.length > 0 && !nameValid(name.trim())
												? true
												: undefined
										}
									/>
									{name.length > 0 && !nameValid(name.trim()) ? (
										<span className="text-[11px] text-destructive">
											Use lowercase letters, numbers, dashes, or underscores.
										</span>
									) : null}
								</div>
								<fieldset className="grid grid-cols-3 gap-2">
									<legend className="sr-only">Project template</legend>
									{(["empty", "nextjs", "turborepo"] as const).map((value) => (
										<button
											key={value}
											type="button"
											onClick={() => setTemplate(value)}
											aria-pressed={template === value}
											className={`min-h-11 rounded-lg border px-3 py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring ${template === value ? "border-foreground/30 bg-accent" : "border-border bg-muted/30 hover:bg-accent/60"}`}
										>
											{value === "empty"
												? "Empty"
												: value === "nextjs"
													? "Next.js"
													: "Turborepo"}
										</button>
									))}
								</fieldset>
								<div className="flex min-h-11 items-center gap-2 text-xs">
									<CheckboxInput
										checked={alsoCreateGithubRepo}
										onChange={setAlsoCreateGithubRepo}
										disabled={!ghAuthenticated}
									/>
									<span>Also create a private GitHub repository</span>
								</div>
							</>
						) : null}

						{mode !== "choose" ? (
							<div className="flex flex-col gap-1.5 text-xs font-medium">
								<span>
									{mode === "existing" ? "Project folder" : "Parent folder"}
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
								Creates <code>{joinPreview(parent, projectName)}</code>
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
							Back
						</Button>
					) : (
						<DialogClose
							render={
								<Button type="button" variant="ghost" disabled={submitting}>
									Cancel
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
								? "Working…"
								: mode === "clone"
									? "Clone project"
									: mode === "create"
										? "Create project"
										: "Add project"}
						</Button>
					) : null}
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}

function SetupChoice({
	icon: Icon,
	label,
	onClick,
}: {
	readonly icon: typeof Folder;
	readonly label: string;
	readonly onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex min-h-24 flex-col items-start justify-between rounded-xl border border-border bg-muted/30 p-3 text-left text-xs font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
		>
			<Icon className="size-4 text-muted-foreground" />
			{label}
		</button>
	);
}
