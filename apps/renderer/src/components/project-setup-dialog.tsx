import type {
	GithubRepoSummary,
	ProjectTemplate,
	Folder as WorkspaceFolder,
} from "@zuse/contracts";
import { Check, Folder, Lock } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

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

type DitherColor = readonly [red: number, green: number, blue: number];

const DITHER_COLORS = {
	amber: [255, 150, 50],
	blue: [53, 143, 243],
	grey: [92, 92, 100],
	pink: [255, 30, 86],
	violet: [150, 110, 255],
} as const satisfies Record<string, DitherColor>;

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
						{connected.length === 0 ? (
							<div
								className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-[11px]"
								role="alert"
							>
								<p className="font-medium text-foreground">
									This computer is unavailable.
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
										? "Retrying…"
										: "Retry connection"}
								</Button>
							</div>
						) : null}

						{mode === "choose" ? (
							<div className="grid gap-2 sm:grid-cols-3">
								<SetupChoice
									art="quick"
									label="Quick start"
									description="Create from a template"
									accent="violet"
									disabled={connected.length === 0}
									onClick={() => setMode("create")}
								/>
								<SetupChoice
									art="github"
									label="Clone repository"
									description="Clone with Git or GitHub"
									accent="blue"
									disabled={connected.length === 0}
									onClick={() => setMode("clone")}
								/>
								<SetupChoice
									art="folder"
									label="Existing folder"
									description="Open a project on disk"
									accent="amber"
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
								(loadingRepos ||
									reposError ||
									repos.length > 0 ||
									!ghAuthenticated) ? (
									<div className="max-h-28 min-h-11 overflow-y-auto rounded-lg border border-border">
										{loadingRepos ? (
											<p className="p-3 text-xs text-muted-foreground">
												Loading repositories…
											</p>
										) : reposError ? (
											<div className="flex min-h-11 items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
												<span className="min-w-0 flex-1">
													GitHub is unavailable. You can still paste a
													repository URL.
												</span>
												<Button
													type="button"
													variant="outline"
													size="sm"
													onClick={() => setReposRequest((value) => value + 1)}
												>
													Retry
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
									{(["empty", "nextjs", "turborepo"] as const).map((value) => {
										const label =
											value === "empty"
												? "Empty"
												: value === "nextjs"
													? "Next.js"
													: "Turborepo";
										const ditherColor: DitherColor =
											value === "turborepo"
												? DITHER_COLORS.pink
												: value === "nextjs"
													? DITHER_COLORS.blue
													: DITHER_COLORS.grey;
										const selected = template === value;
										const selectedClass =
											value === "turborepo"
												? "border-[#ff1e56]/70 bg-[#ff1e56]/[0.07] ring-1 ring-inset ring-[#ff1e56]/30"
												: value === "nextjs"
													? "border-sky-400/70 bg-sky-400/[0.07] ring-1 ring-inset ring-sky-400/30"
													: "border-foreground/60 bg-foreground/[0.04] ring-1 ring-inset ring-foreground/25";
										return (
											<button
												key={value}
												type="button"
												onClick={() => setTemplate(value)}
												aria-pressed={selected}
												className={`group relative isolate flex min-h-11 items-center justify-center gap-2 overflow-hidden rounded-lg border px-3 py-2 text-xs outline-none transition-[border-color,background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ${selected ? selectedClass : "border-border"}`}
											>
												<DitherField color={ditherColor} active={selected} />
												<span className="relative flex items-center gap-2">
													<TemplateLogo template={value} />
													<span>{label}</span>
												</span>
												{selected ? (
													<span className="absolute right-2 flex size-4 items-center justify-center rounded-full bg-background/80 shadow-sm ring-1 ring-current/20">
														<Check aria-hidden="true" className="size-2.5" />
													</span>
												) : null}
											</button>
										);
									})}
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

						{mode !== "choose" && selectedEnvironment !== undefined ? (
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
	art,
	label,
	description,
	accent,
	disabled,
	onClick,
}: {
	readonly art: "quick" | "github" | "folder";
	readonly label: string;
	readonly description: string;
	readonly accent: "violet" | "blue" | "amber";
	readonly disabled: boolean;
	readonly onClick: () => void;
}) {
	const accentClass = {
		violet:
			"hover:border-primary/30 hover:bg-primary/[0.04] [--choice-accent:var(--primary)]",
		blue: "hover:border-sky-500/30 hover:bg-sky-500/[0.04] [--choice-accent:theme(colors.sky.500)]",
		amber:
			"hover:border-amber-500/30 hover:bg-amber-500/[0.04] [--choice-accent:theme(colors.amber.500)]",
	}[accent];
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className={`group flex min-h-40 flex-col overflow-hidden rounded-xl border border-border bg-muted/20 text-left outline-none transition-[border-color,background-color] duration-150 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none ${accentClass}`}
		>
			<AsciiProjectArt variant={art} accent={accent} />
			<span className="flex w-full flex-col gap-0.5 border-t border-border/70 px-3 py-2.5">
				<span className="text-xs font-medium text-foreground">{label}</span>
				<span className="text-[10px] font-normal text-muted-foreground">
					{description}
				</span>
			</span>
		</button>
	);
}

function AsciiProjectArt({
	variant,
	accent,
}: {
	readonly variant: "quick" | "github" | "folder";
	readonly accent: "violet" | "blue" | "amber";
}) {
	const color: DitherColor =
		accent === "violet"
			? DITHER_COLORS.violet
			: accent === "blue"
				? DITHER_COLORS.blue
				: DITHER_COLORS.amber;
	return (
		<span
			aria-hidden="true"
			className="relative flex min-h-24 w-full flex-1 items-center justify-center overflow-hidden bg-muted/30 text-foreground/75"
		>
			<DitherField color={color} />
			{variant === "quick" ? (
				<span className="relative flex items-center gap-3">
					<NextJsLogo className="size-10 transition-colors duration-150 group-hover:text-foreground motion-reduce:transition-none" />
					<span className="h-8 w-px bg-border" />
					<TurborepoLogo className="size-10 text-muted-foreground transition-colors duration-150 group-hover:text-[#ff1e56] motion-reduce:transition-none" />
				</span>
			) : variant === "github" ? (
				<GitHubLogo className="relative size-11 transition-colors duration-150 group-hover:text-[#6e40c9] motion-reduce:transition-none" />
			) : (
				<Folder className="relative size-11 fill-current stroke-[1.25] text-muted-foreground transition-colors duration-150 group-hover:text-amber-500 motion-reduce:transition-none" />
			)}
		</span>
	);
}

const BAYER_4 = [
	[0, 8, 2, 10],
	[12, 4, 14, 6],
	[3, 11, 1, 9],
	[15, 7, 13, 5],
] as const;

function DitherField({
	color,
	active = false,
}: {
	readonly color: DitherColor;
	readonly active?: boolean;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		const button = canvas?.closest("button");
		const context = canvas?.getContext("2d");
		if (canvas == null || button == null || context == null) return;

		let columns = 0;
		let rows = 0;
		const restingIntensity = active ? 0.65 : 0;
		let intensity = restingIntensity;
		let target = restingIntensity;
		let hovered = false;
		let animationFrame = 0;
		const reducedMotion = window.matchMedia?.(
			"(prefers-reduced-motion: reduce)",
		).matches;

		const paint = (): void => {
			context.clearRect(0, 0, columns, rows);
			for (let y = 0; y < rows; y += 1) {
				const density = 0.25 + 0.75 * ((y + 0.5) / rows);
				for (let x = 0; x < columns; x += 1) {
					const threshold = (BAYER_4[y & 3]?.[x & 3] ?? 0) / 16;
					const lit = density > threshold - 0.1 * intensity;
					const strength = (0.3 + density * 0.7) * (1 + 0.22 * intensity);
					const alpha = Math.min(1, lit ? strength : strength * 0.4);
					context.fillStyle = `rgba(${Math.round(color[0] * strength)}, ${Math.round(color[1] * strength)}, ${Math.round(color[2] * strength)}, ${alpha})`;
					context.fillRect(x, y, 1, 1);
				}
			}
		};

		const tick = (): void => {
			const distance = target - intensity;
			if (Math.abs(distance) < 0.01) {
				intensity = target;
				paint();
				animationFrame = 0;
				return;
			}
			intensity += distance * 0.16;
			paint();
			animationFrame = window.requestAnimationFrame(tick);
		};
		const setTarget = (next: number): void => {
			target = next;
			if (reducedMotion) {
				intensity = next;
				paint();
			} else if (animationFrame === 0) {
				animationFrame = window.requestAnimationFrame(tick);
			}
		};
		const resize = (): void => {
			const bounds = button.getBoundingClientRect();
			columns = Math.max(4, Math.round(bounds.width / 2));
			rows = Math.max(4, Math.round(bounds.height / 2));
			canvas.width = columns;
			canvas.height = rows;
			paint();
		};
		const enter = (): void => {
			hovered = true;
			setTarget(1);
		};
		const leave = (): void => {
			hovered = false;
			setTarget(restingIntensity);
		};
		const down = (): void => setTarget(1.5);
		const up = (): void => setTarget(hovered ? 1 : restingIntensity);

		resize();
		button.addEventListener("pointerenter", enter);
		button.addEventListener("pointerleave", leave);
		button.addEventListener("pointerdown", down);
		button.addEventListener("pointerup", up);
		button.addEventListener("pointercancel", up);
		const resizeObserver = new ResizeObserver(resize);
		resizeObserver.observe(button);

		return () => {
			if (animationFrame !== 0) window.cancelAnimationFrame(animationFrame);
			button.removeEventListener("pointerenter", enter);
			button.removeEventListener("pointerleave", leave);
			button.removeEventListener("pointerdown", down);
			button.removeEventListener("pointerup", up);
			button.removeEventListener("pointercancel", up);
			resizeObserver.disconnect();
		};
	}, [active, color]);

	return (
		<canvas
			ref={canvasRef}
			className="pointer-events-none absolute inset-0 h-full w-full opacity-45"
			style={{ imageRendering: "pixelated" }}
		/>
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
			<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
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
