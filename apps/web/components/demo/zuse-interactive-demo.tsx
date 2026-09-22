"use client";
import "./demo-theme.css";
import { Popover } from "@base-ui/react/popover";
import { HugeiconsIcon } from "@hugeicons/react";
import { DitherAvatar, DitherButton } from "@repo/ui/dither";
import {
	useWebsiteMessages,
	type WebsiteMessage,
} from "@zuse/i18n/website/react";
import {
	Add01Icon,
	ArrowDown01Icon,
	AttachmentIcon,
	Cancel01Icon,
	ChatDownload01Icon,
	CloudIcon,
	CodeIcon,
	ComputerIcon,
	FlashIcon,
	Folder01Icon,
	FolderAddIcon,
	GitBranchIcon,
	GitPullRequestIcon,
	MapsIcon,
	Moon02Icon,
	PencilEdit01Icon,
	Search01Icon,
	SentIcon,
	Settings01Icon,
	SidebarLeft01Icon,
	SidebarRight01Icon,
	SquareUnlock01Icon,
	Sun03Icon,
	Tick02Icon,
} from "@zuse/icons/solid-rounded";
import Image from "next/image";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { cn } from "@/lib/utils";

type MenuName =
	| "project"
	| "environment"
	| "source"
	| "model"
	| "import"
	| "access"
	| "worktree";
type Provider = "claude" | "codex" | "kiro" | "opencode";
type Environment = "local" | "cloud";

type DemoModel = {
	id: string;
	provider: Provider;
	label: string;
	context: string;
	badge?: string;
};

const REASONING_LEVELS = ["Low", "Medium", "High", "Ultracode"];

const providerMeta: Record<
	Provider,
	{ label: string; logo: string; monochrome?: boolean }
> = {
	claude: {
		label: "Claude Code",
		logo: "/logos/claude.svg",
		monochrome: true,
	},
	codex: { label: "Codex", logo: "/logos/openai.svg", monochrome: true },
	kiro: { label: "Kiro", logo: "/logos/kiro.svg" },
	opencode: {
		label: "OpenCode",
		logo: "/logos/opencode.svg",
		monochrome: true,
	},
};

const getModels = (t: WebsiteMessage): DemoModel[] => [
	{
		id: "gpt-5.6-sol",
		provider: "codex",
		label: "GPT-5.6 Sol",
		context: "1M",
		badge: t("demo:default"),
	},
	{
		id: "gpt-5.6-terra",
		provider: "codex",
		label: "GPT-5.6 Terra",
		context: "1M",
	},
	{
		id: "sonnet-5",
		provider: "claude",
		label: "Sonnet 5",
		context: "200K",
	},
	{
		id: "opus-4.8",
		provider: "claude",
		label: "Opus 4.8",
		context: "200K",
	},
	{
		id: "opencode-sonnet-5",
		provider: "opencode",
		label: "Claude Sonnet 5",
		context: "200K",
	},
	{
		id: "opencode-gpt-5.6",
		provider: "opencode",
		label: "GPT-5.6 Sol",
		context: "1M",
	},
	{
		id: "kiro-auto",
		provider: "kiro",
		label: "Kiro Auto",
		context: "200K",
	},
];

const getSidebarProjects = (t: WebsiteMessage) =>
	[
		{
			name: "zuse",
			chats: [
				{ title: t("demo:new_chat"), additions: "+4", deletions: "−8" },
				{
					title: t("demo:polish_the_chat_landing"),
					additions: "+151",
					deletions: "−9",
				},
			],
		},
		{
			name: "forkzero",
			chats: [
				{
					title: t("demo:implement_cloud_environments"),
					additions: "+79",
					deletions: "−1",
				},
				{
					title: t("demo:fix_composer_focus"),
					additions: "+45",
					deletions: "−4",
				},
				{
					title: t("demo:review_current_changes"),
					additions: "+101",
					deletions: "−10",
				},
			],
		},
		{ name: "server", chats: [] },
		{ name: "mobile", chats: [] },
		{ name: "marketing-site", chats: [] },
		{ name: "desktop", chats: [] },
		{ name: "docs", chats: [] },
	] as const;

const getSourceRows = (t: WebsiteMessage) => ({
	prs: [
		{ label: "#248 Polish the chat landing", meta: "14m" },
		{ label: "#244 Add cloud environments", meta: "2h" },
	],
	branches: [
		{
			label: "feature/chat-landing",
			meta: t("demo:commits_ahead", { count: 3 }),
		},
		{
			label: "fix/composer-focus",
			meta: t("demo:commits_ahead", { count: 1 }),
		},
	],
	issues: [
		{
			label: t("demo:zus_184_composer_polish"),
			meta: t("demo:reasoning_high"),
		},
		{
			label: t("demo:zus_179_cloud_reconnect"),
			meta: t("demo:reasoning_medium"),
		},
	],
});

const getContinueThreads = (t: WebsiteMessage) =>
	[
		{
			title: t("demo:improve_the_chat_landing_background"),
			preview:
				"Keep the renderer composer unchanged and add the visual treatment behind it.",
			project: "zuse",
			time: t("demo:now"),
		},
		{
			title: t("demo:generate_a_concise_semantic_branch_name"),
			preview:
				"Use the current diff and return a short branch name for the following task.",
			project: "forkzero",
			time: "8m",
		},
		{
			title: t("demo:review_the_current_implementation"),
			preview:
				"Inspect the changed files, identify regressions, and report only actionable findings.",
			project: "renderer",
			time: "22m",
		},
	] as const;

function ProviderLogo({
	provider,
	className,
}: {
	provider: Provider;
	className?: string;
}) {
	const meta = providerMeta[provider];
	return (
		<Image
			src={meta.logo}
			alt=""
			width={16}
			height={16}
			className={cn(
				"object-contain opacity-80",
				meta.monochrome && "zuse-provider-logo--monochrome",
				className,
			)}
		/>
	);
}

export function ZuseInteractiveDemo({
	embedded = false,
}: {
	embedded?: boolean;
}) {
	const { message: t } = useWebsiteMessages();

	const [theme, setTheme] = useState<"light" | "dark">("dark");
	const [project, setProject] = useState("forkzero");
	const [environment, setEnvironment] = useState<Environment>("local");
	const [expandedProjects, setExpandedProjects] = useState(
		() => new Set(["forkzero"]),
	);
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [modelId, setModelId] = useState("gpt-5.6-sol");
	const [reasoning, setReasoning] = useState("Medium");
	const [fullAccess, setFullAccess] = useState(true);
	const [useWorktree, setUseWorktree] = useState(true);
	const [planMode, setPlanMode] = useState(false);
	const [menu, setMenu] = useState<MenuName | null>(null);
	const [sourceTab, setSourceTab] =
		useState<keyof ReturnType<typeof getSourceRows>>("prs");
	const [source, setSource] = useState<string | null>(null);
	const [prompt, setPrompt] = useState("");
	const [submitted, setSubmitted] = useState(false);
	const shellRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (embedded) return;
		const previous = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = previous;
		};
	}, [embedded]);

	useEffect(() => {
		const close = (event: PointerEvent) => {
			if (!shellRef.current?.contains(event.target as Node)) setMenu(null);
		};
		const closeWithKeyboard = (event: KeyboardEvent) => {
			if (event.key === "Escape") setMenu(null);
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", closeWithKeyboard);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", closeWithKeyboard);
		};
	}, []);

	const activeModel =
		getModels(t).find((entry) => entry.id === modelId) ?? getModels(t)[0];
	const ComposerHeading = embedded ? "h2" : "h1";
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (prompt.trim().length === 0) return;
		setSubmitted(true);
		window.setTimeout(() => setSubmitted(false), 2200);
	};
	const selectProject = (name: string) => {
		setProject(name);
		setExpandedProjects((current) => new Set(current).add(name));
		setMenu(null);
	};

	return (
		<div
			data-zuse-demo
			data-theme={theme}
			className={cn(
				embedded
					? "relative h-[720px] w-full overflow-hidden bg-background text-foreground"
					: "fixed inset-0 z-[100] overflow-hidden bg-background text-foreground",
				theme === "dark" && "dark",
			)}
		>
			<style>{`
				${
					embedded
						? ""
						: `body:has([data-zuse-demo]) > div > nav,
				body:has([data-zuse-demo]) > div > footer { display: none !important; }`
				}

				[data-theme="dark"] .zuse-provider-logo--monochrome {
					filter: invert(1);
					opacity: .82;
				}
				@media (prefers-reduced-motion: reduce) {
					.zuse-demo-pulse { animation: none !important; }
				}
			`}</style>

			<div className="flex h-full min-h-0">
				{sidebarOpen ? (
					<DemoSidebar
						project={project}
						expandedProjects={expandedProjects}
						theme={theme}
						onClose={() => setSidebarOpen(false)}
						onSelectProject={selectProject}
						onToggleProject={(name) => {
							setExpandedProjects((current) => {
								const next = new Set(current);
								if (next.has(name)) next.delete(name);
								else next.add(name);
								return next;
							});
						}}
						onToggleTheme={() =>
							setTheme((current) => (current === "dark" ? "light" : "dark"))
						}
					/>
				) : null}

				<div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
					{!sidebarOpen ? (
						<button
							type="button"
							aria-label={t("demo:show_projects_panel")}
							className="absolute left-2 top-2 z-30 flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
							onClick={() => setSidebarOpen(true)}
						>
							<HugeiconsIcon icon={SidebarRight01Icon} size={16} />
						</button>
					) : null}

					<button
						type="button"
						aria-label={t(
							theme === "dark" ? "demo:light_theme" : "demo:dark_theme",
						)}
						className="absolute right-2 top-2 z-30 flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary md:hidden"
						onClick={() =>
							setTheme((current) => (current === "dark" ? "light" : "dark"))
						}
					>
						{theme === "dark" ? (
							<HugeiconsIcon icon={Sun03Icon} size={16} />
						) : (
							<HugeiconsIcon icon={Moon02Icon} size={16} />
						)}
					</button>

					<main className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-end overflow-y-auto px-3 pt-12 pb-6 sm:px-6">
						<div
							ref={shellRef}
							className="flex h-full w-full max-w-3xl flex-col justify-end gap-4"
						>
							<ComposerHeading className="absolute inset-x-4 top-[38%] text-center text-xl font-medium text-foreground/90">
								{t("demo:what_should_we_build_in", { value0: project })}
							</ComposerHeading>

							<form onSubmit={submit} className="w-full">
								<div className="relative flex flex-col">
									<div className="zuse-attached-toolbar relative z-20 mx-auto flex min-h-8 w-14/15 items-center justify-between gap-2 rounded-t-[1.2rem] px-2 py-1.5">
										<div className="flex min-w-0 items-center gap-1">
											<CompactMenuButton
												menuId="project"
												label={project}
												ariaLabel={t("demo:pick_project")}
												icon={<HugeiconsIcon icon={Folder01Icon} size={14} />}
												open={menu === "project"}
												onClick={() =>
													setMenu(menu === "project" ? null : "project")
												}
											/>
											<CompactMenuButton
												menuId="environment"
												label={
													environment === "local"
														? t("demo:this_computer")
														: t("demo:cloud")
												}
												ariaLabel={t("demo:choose_environment")}
												icon={
													environment === "local" ? (
														<HugeiconsIcon icon={ComputerIcon} size={14} />
													) : (
														<HugeiconsIcon icon={CloudIcon} size={14} />
													)
												}
												open={menu === "environment"}
												onClick={() =>
													setMenu(menu === "environment" ? null : "environment")
												}
											/>
											<div className="hidden lg:flex">
												<CompactMenuButton
													menuId="worktree"
													label={t(
														useWorktree ? "demo:worktree" : "demo:local",
													)}
													ariaLabel={t("demo:worktree")}
													icon={
														<HugeiconsIcon icon={GitBranchIcon} size={14} />
													}
													open={menu === "worktree"}
													onClick={() =>
														setMenu(menu === "worktree" ? null : "worktree")
													}
												/>
												<CompactMenuButton
													menuId="import"
													label={t("demo:import_chat")}
													ariaLabel={t("demo:import_chat")}
													icon={
														<HugeiconsIcon
															icon={ChatDownload01Icon}
															size={14}
														/>
													}
													open={menu === "import"}
													onClick={() =>
														setMenu(menu === "import" ? null : "import")
													}
												/>
											</div>
											{menu === "worktree" && (
												<MenuPanel
													anchorId="worktree"
													side="left"
													className="w-44"
												>
													{[true, false].map((value) => (
														<MenuRow
															key={String(value)}
															selected={useWorktree === value}
															icon={
																<HugeiconsIcon icon={GitBranchIcon} size={14} />
															}
															onClick={() => {
																setUseWorktree(value);
																setMenu(null);
															}}
														>
															{t(value ? "demo:worktree" : "demo:local")}
														</MenuRow>
													))}
												</MenuPanel>
											)}
											{menu === "import" && (
												<MenuPanel
													anchorId="import"
													side="left"
													className="w-72"
												>
													{getContinueThreads(t).map((thread) => (
														<MenuRow
															key={thread.title}
															icon={
																<HugeiconsIcon
																	icon={ChatDownload01Icon}
																	size={14}
																/>
															}
															onClick={() => {
																setPrompt(`${thread.title}\n${thread.preview}`);
																setMenu(null);
															}}
														>
															{thread.title}
														</MenuRow>
													))}
												</MenuPanel>
											)}
										</div>
										<div className="flex min-w-0 items-center gap-1.5">
											{source !== null ? (
												<span className="hidden min-w-0 items-center gap-1 rounded-md bg-secondary/80 py-1 pl-2 pr-1 text-[11px] text-muted-foreground sm:flex">
													<span className="max-w-40 truncate">{source}</span>
													<button
														type="button"
														aria-label={t("demo:clear_create_from_source")}
														className="rounded p-1 hover:bg-card hover:text-foreground"
														onClick={() => setSource(null)}
													>
														<HugeiconsIcon icon={Cancel01Icon} size={12} />
													</button>
												</span>
											) : null}
											<CompactMenuButton
												menuId="source"
												label={t("demo:create_from")}
												ariaLabel={t("demo:create_from_source")}
												icon={
													<HugeiconsIcon icon={GitPullRequestIcon} size={14} />
												}
												open={menu === "source"}
												collapseOnMobile
												onClick={() =>
													setMenu(menu === "source" ? null : "source")
												}
											/>
										</div>

										{menu === "project" ? (
											<MenuPanel
												anchorId="project"
												side="left"
												className="max-h-64 w-52 overflow-y-auto"
											>
												{getSidebarProjects(t).map((entry) => (
													<MenuRow
														key={entry.name}
														selected={entry.name === project}
														icon={
															<HugeiconsIcon icon={Folder01Icon} size={14} />
														}
														onClick={() => selectProject(entry.name)}
													>
														{entry.name}
													</MenuRow>
												))}
												<div className="my-1 h-px bg-border" />
												<MenuRow
													icon={<HugeiconsIcon icon={Add01Icon} size={14} />}
													onClick={() => setMenu(null)}
												>
													{t("demo:add_project")}
												</MenuRow>
											</MenuPanel>
										) : null}

										{menu === "environment" ? (
											<MenuPanel
												anchorId="environment"
												side="left"
												className="w-60"
											>
												<MenuRow
													selected={environment === "local"}
													icon={<HugeiconsIcon icon={ComputerIcon} size={14} />}
													meta={t("demo:this_mac")}
													onClick={() => {
														setEnvironment("local");
														setMenu(null);
													}}
												>
													{t("demo:local_workspace")}
												</MenuRow>
												<MenuRow
													selected={environment === "cloud"}
													icon={<HugeiconsIcon icon={CloudIcon} size={14} />}
													meta={t("demo:live_beta")}
													onClick={() => {
														setEnvironment("cloud");
														setMenu(null);
													}}
												>
													{t("demo:cloud_workspace")}
												</MenuRow>
											</MenuPanel>
										) : null}

										{menu === "source" ? (
											<MenuPanel
												anchorId="source"
												side="right"
												className="w-[min(30rem,calc(100vw-2rem))] overflow-hidden p-0"
											>
												<div className="flex items-center gap-2 border-b border-border px-3 py-2">
													<HugeiconsIcon
														icon={Search01Icon}
														size={16}
														className="text-muted-foreground"
													/>
													<input
														aria-label={t("demo:search_create_from_sources")}
														placeholder={t(
															"demo:search_by_title_number_or_author",
														)}
														className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
													/>
												</div>
												<div className="flex gap-1 border-b border-border px-2 py-1.5">
													{(["prs", "branches", "issues"] as const).map(
														(tab) => (
															<button
																key={tab}
																type="button"
																className={cn(
																	"min-h-9 rounded-md px-2.5 text-xs font-medium capitalize transition-colors",
																	sourceTab === tab
																		? "bg-secondary text-foreground"
																		: "text-muted-foreground hover:text-foreground",
																)}
																onClick={() => setSourceTab(tab)}
															>
																{t(
																	tab === "prs"
																		? "demo:pull_requests"
																		: tab === "branches"
																			? "demo:branches"
																			: "demo:issues",
																)}
															</button>
														),
													)}
												</div>
												<div className="p-1">
													{getSourceRows(t)[sourceTab].map((row) => (
														<MenuRow
															key={row.label}
															icon={
																sourceTab === "branches" ? (
																	<HugeiconsIcon
																		icon={GitBranchIcon}
																		size={14}
																	/>
																) : sourceTab === "issues" ? (
																	<HugeiconsIcon icon={FlashIcon} size={14} />
																) : (
																	<HugeiconsIcon
																		icon={GitPullRequestIcon}
																		size={14}
																	/>
																)
															}
															meta={row.meta}
															onClick={() => {
																setSource(row.label);
																setMenu(null);
															}}
														>
															{row.label}
														</MenuRow>
													))}
												</div>
											</MenuPanel>
										) : null}
									</div>

									<div
										className={cn(
											"zuse-composer-glass relative min-h-16 rounded-t-[1.2rem] border-x border-t transition-colors",
											planMode ? "border-rose-300/50" : "border-border/60",
										)}
									>
										<textarea
											value={prompt}
											onChange={(event) => setPrompt(event.target.value)}
											onKeyDown={(event) => {
												if (
													event.key === "Enter" &&
													!event.shiftKey &&
													!event.nativeEvent.isComposing &&
													event.nativeEvent.keyCode !== 229
												) {
													event.preventDefault();
													event.currentTarget.form?.requestSubmit();
												}
											}}
											aria-label={t("demo:message")}
											placeholder={t(
												"demo:ask_to_make_changes_at_the_mentioned_files_or_run_slash_commands_shift",
											)}
											className="min-h-16 w-full resize-none bg-transparent px-3 pt-3 pb-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/75"
										/>
									</div>

									<div className="zuse-composer-glass relative z-30 flex h-11 items-center justify-between gap-2 rounded-b-[1.2rem] border-x border-b border-border/60 px-2.5 pb-2 pt-1">
										<div className="flex min-w-0 items-center gap-0.5 sm:gap-1.5">
											<IconButton label={t("demo:attach_files")}>
												<HugeiconsIcon icon={AttachmentIcon} size={15} />
											</IconButton>
											<button
												type="button"
												data-demo-menu-trigger="access"
												aria-expanded={menu === "access"}
												onClick={() =>
													setMenu(menu === "access" ? null : "access")
												}
												className="flex h-7 items-center gap-1 rounded-md px-1 text-xs text-[var(--warning)] hover:bg-secondary"
											>
												<HugeiconsIcon icon={SquareUnlock01Icon} size={14} />
												<span className="hidden sm:inline">
													{t(
														fullAccess ? "demo:full_access" : "demo:ask_first",
													)}
												</span>
												<HugeiconsIcon icon={ArrowDown01Icon} size={12} />
											</button>
											{menu === "access" && (
												<MenuPanel
													anchorId="access"
													side="left"
													className="w-44"
												>
													{[true, false].map((value) => (
														<MenuRow
															key={String(value)}
															icon={
																<HugeiconsIcon
																	icon={SquareUnlock01Icon}
																	size={14}
																/>
															}
															selected={fullAccess === value}
															onClick={() => {
																setFullAccess(value);
																setMenu(null);
															}}
														>
															{t(value ? "demo:full_access" : "demo:ask_first")}
														</MenuRow>
													))}
												</MenuPanel>
											)}
											<IconButton
												label={
													planMode
														? t("demo:exit_plan_mode")
														: t("demo:enter_plan_mode")
												}
												pressed={planMode}
												onClick={() => setPlanMode((current) => !current)}
												className={
													planMode ? "bg-rose-400/15 text-rose-500" : undefined
												}
											>
												<HugeiconsIcon icon={MapsIcon} size={15} />
											</IconButton>
											<IconButton label={t("demo:mcp_servers")}>
												<HugeiconsIcon icon={CodeIcon} size={15} />
											</IconButton>
										</div>
										<div className="flex shrink-0 items-center gap-1">
											<button
												type="button"
												aria-label={t("demo:change_model")}
												aria-expanded={menu === "model"}
												className="flex h-7 items-center gap-1.5 rounded-full bg-secondary px-2.5 text-xs text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
												onClick={() =>
													setMenu(menu === "model" ? null : "model")
												}
											>
												<ProviderLogo
													provider={activeModel.provider}
													className="size-3.5"
												/>
												<span className="max-w-24 truncate">
													{activeModel.label.replace("GPT-", "")}
												</span>
												<span className="text-muted-foreground">
													{reasoningLabel(reasoning, t)}
												</span>
												<HugeiconsIcon
													icon={ArrowDown01Icon}
													size={12}
													className="opacity-60"
												/>
											</button>
											<DitherButton
												type="submit"
												variant="gradient"
												aria-label={t("demo:send")}
												disabled={prompt.trim().length === 0 || submitted}
												className="size-7 shrink-0 border border-primary/40 text-white active:scale-95 focus-visible:ring-offset-1"
											>
												{submitted ? (
													<span className="zuse-demo-pulse size-2 animate-pulse rounded-full bg-current" />
												) : (
													<HugeiconsIcon
														icon={SentIcon}
														size={15}
														strokeWidth={2}
													/>
												)}
											</DitherButton>
										</div>

										{menu === "model" ? (
											<DemoModelPicker
												activeModel={activeModel}
												reasoning={reasoning}
												onReasoningChange={setReasoning}
												onSelect={(next) => {
													setModelId(next.id);
													setMenu(null);
												}}
											/>
										) : null}
									</div>
								</div>
							</form>

							<div
								aria-live="polite"
								className="h-4 text-center text-xs text-muted-foreground"
							>
								{submitted
									? t("demo:starting", {
											model: providerMeta[activeModel.provider].label,
											project,
											environment: t(
												environment === "local"
													? "demo:environment_local"
													: "demo:environment_cloud",
											),
										})
									: ""}
							</div>
						</div>
					</main>
				</div>
			</div>
		</div>
	);
}

function DemoSidebar({
	project,
	expandedProjects,
	theme,
	onClose,
	onSelectProject,
	onToggleProject,
	onToggleTheme,
}: {
	project: string;
	expandedProjects: ReadonlySet<string>;
	theme: "light" | "dark";
	onClose: () => void;
	onSelectProject: (name: string) => void;
	onToggleProject: (name: string) => void;
	onToggleTheme: () => void;
}) {
	const { message: t } = useWebsiteMessages();

	return (
		<aside className="hidden h-full min-h-0 w-[232px] shrink-0 flex-col border-r border-border bg-[var(--sidebar)] text-foreground md:flex">
			<header className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3 text-[11px]">
				<span className="truncate font-semibold tracking-tight">
					{t("demo:zuse_beta")}
				</span>
				<span className="flex-1" />
				<button
					type="button"
					aria-label={t("demo:hide_projects_panel")}
					className="flex size-7 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
					onClick={onClose}
				>
					<HugeiconsIcon icon={SidebarLeft01Icon} size={15} />
				</button>
			</header>
			<div className="flex flex-col gap-0.5 border-b border-border px-1.5 py-1.5">
				<SidebarAction
					icon={<HugeiconsIcon icon={PencilEdit01Icon} size={16} />}
					label={t("demo:new_chat")}
					shortcut="⌘ N"
				/>
				<SidebarAction
					icon={<HugeiconsIcon icon={FolderAddIcon} size={16} />}
					label={t("demo:new_project")}
				/>
			</div>
			<div className="flex items-center justify-between px-2.5 py-1.5 text-[12px] text-muted-foreground">
				<span>{t("demo:projects")}</span>
				<button
					type="button"
					aria-label={t("demo:add_project_2")}
					className="flex size-7 items-center justify-center rounded-md hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
				>
					<HugeiconsIcon icon={Add01Icon} size={14} />
				</button>
			</div>
			<ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
				{getSidebarProjects(t).map((entry) => {
					const expanded = expandedProjects.has(entry.name);
					return (
						<li key={entry.name}>
							<div
								className={cn(
									"group flex min-h-7 items-center gap-1.5 rounded-md px-2 hover:bg-secondary",
									entry.name === project && "bg-secondary/80",
								)}
							>
								<button
									type="button"
									className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary"
									onClick={() => {
										if (entry.name === project) onToggleProject(entry.name);
										else onSelectProject(entry.name);
									}}
								>
									<span
										className={cn(
											"grid size-4 shrink-0 place-items-center rounded bg-card/75 ring-1 ring-border/55",
											entry.name === project && "bg-primary/10 ring-primary/25",
										)}
									>
										<DitherAvatar
											name={entry.name}
											size={11}
											hue={entry.name === project ? 78 : undefined}
										/>
									</span>
									<span className="min-w-0 flex-1 truncate text-[12px]">
										{entry.name}
									</span>
								</button>
								<button
									type="button"
									aria-label={t("demo:settings_for", { value0: entry.name })}
									className="rounded p-1 text-muted-foreground opacity-0 hover:bg-card hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
								>
									<HugeiconsIcon icon={Settings01Icon} size={14} />
								</button>
								<button
									type="button"
									aria-label={t("demo:new_chat_in", { value0: entry.name })}
									className="rounded p-1 text-muted-foreground opacity-0 hover:bg-card hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
								>
									<HugeiconsIcon icon={PencilEdit01Icon} size={14} />
								</button>
							</div>
							{expanded && entry.chats.length > 0 ? (
								<ul aria-label={t("demo:chats", { value0: entry.name })}>
									{entry.chats.map((chat) => (
										<li key={chat.title}>
											<button
												type="button"
												className="group flex min-h-7 w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] text-muted-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
											>
												<HugeiconsIcon
													icon={GitBranchIcon}
													size={14}
													className="ml-3 shrink-0 text-violet-400"
												/>
												<span className="min-w-0 flex-1 truncate">
													{chat.title}
												</span>
												<span className="shrink-0 tabular-nums text-[10px]">
													<span className="text-emerald-500">
														{chat.additions}
													</span>{" "}
													<span className="text-rose-500">
														{chat.deletions}
													</span>
												</span>
											</button>
										</li>
									))}
								</ul>
							) : null}
						</li>
					);
				})}
			</ul>
			<div className="flex items-center gap-2 border-t border-border px-2 py-1.5">
				<span className="grid size-6 shrink-0 place-items-center rounded-md bg-card ring-1 ring-border/55">
					<DitherAvatar name="Zuse workspace" size={15} hue={78} />
				</span>
				<span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
					{t("demo:zuse_workspace")}
				</span>
				<button
					type="button"
					aria-label={t(
						theme === "dark" ? "demo:light_theme" : "demo:dark_theme",
					)}
					className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
					onClick={onToggleTheme}
				>
					{theme === "dark" ? (
						<HugeiconsIcon icon={Sun03Icon} size={15} />
					) : (
						<HugeiconsIcon icon={Moon02Icon} size={15} />
					)}
				</button>
			</div>
		</aside>
	);
}

function SidebarAction({
	icon,
	label,
	shortcut,
}: {
	icon: ReactNode;
	label: string;
	shortcut?: string;
}) {
	return (
		<button
			type="button"
			className="flex min-h-7 w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-left text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
		>
			<span className="shrink-0">{icon}</span>
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{shortcut ? (
				<kbd className="font-sans text-[11px] opacity-60">{shortcut}</kbd>
			) : null}
		</button>
	);
}

function CompactMenuButton({
	menuId,
	label,
	ariaLabel,
	icon,
	open,
	collapseOnMobile = false,
	onClick,
}: {
	menuId: MenuName;
	label: string;
	ariaLabel: string;
	icon: ReactNode;
	open: boolean;
	collapseOnMobile?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			data-demo-menu-trigger={menuId}
			aria-label={ariaLabel}
			aria-expanded={open}
			className={cn(
				"flex h-7 min-w-0 max-w-44 items-center gap-1.5 rounded-md px-2 text-[11px] text-foreground hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
				collapseOnMobile && "max-sm:w-8 max-sm:px-2",
			)}
			onClick={onClick}
		>
			<span className="shrink-0 text-muted-foreground">{icon}</span>
			<span className={cn("truncate", collapseOnMobile && "max-sm:sr-only")}>
				{label}
			</span>
			<HugeiconsIcon
				icon={ArrowDown01Icon}
				size={12}
				className={cn(
					"shrink-0 opacity-60",
					collapseOnMobile && "max-sm:hidden",
				)}
			/>
		</button>
	);
}

function DemoModelPicker({
	activeModel,
	reasoning,
	onReasoningChange,
	onSelect,
}: {
	activeModel: DemoModel;
	reasoning: string;
	onReasoningChange: (value: string) => void;
	onSelect: (model: DemoModel) => void;
}) {
	const { message: t } = useWebsiteMessages();

	const [scope, setScope] = useState<Provider | "all">("all");
	const [query, setQuery] = useState("");
	const visibleModels = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		return getModels(t).filter(
			(model) =>
				(scope === "all" || model.provider === scope) &&
				(normalized.length === 0 ||
					model.label.toLowerCase().includes(normalized) ||
					providerMeta[model.provider].label
						.toLowerCase()
						.includes(normalized)),
		);
	}, [query, scope, t]);
	const grouped = (Object.keys(providerMeta) as Provider[])
		.map((provider) => ({
			provider,
			models: visibleModels.filter((model) => model.provider === provider),
		}))
		.filter((group) => group.models.length > 0)
		.sort(
			(a, b) =>
				Number(b.provider === activeModel.provider) -
				Number(a.provider === activeModel.provider),
		);
	return (
		<div
			role="dialog"
			aria-label={t("demo:choose_a_model")}
			className="absolute bottom-12 right-0 z-50 flex h-[360px] w-[min(340px,100%)] overflow-hidden rounded-xl border border-border bg-[var(--popover)] text-foreground shadow-xl"
		>
			<div
				role="tablist"
				aria-label={t("demo:model_provider")}
				className="flex w-9 shrink-0 flex-col items-center gap-1 p-1"
			>
				<button
					type="button"
					role="tab"
					aria-selected={scope === "all"}
					aria-label={t("demo:all_models")}
					className={cn(
						"flex size-7 items-center justify-center rounded-md text-[10px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
						scope === "all"
							? "bg-primary/15 text-foreground ring-1 ring-primary/20"
							: "text-muted-foreground hover:bg-secondary hover:text-foreground",
					)}
					onClick={() => setScope("all")}
				>
					{t("demo:all")}
				</button>
				{(Object.keys(providerMeta) as Provider[]).map((provider) => (
					<button
						key={provider}
						type="button"
						role="tab"
						aria-selected={scope === provider}
						aria-label={t("demo:models", {
							value0: providerMeta[provider].label,
						})}
						title={t("demo:models", { value0: providerMeta[provider].label })}
						className={cn(
							"relative flex size-7 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
							scope === provider
								? "bg-primary/15 ring-1 ring-primary/20"
								: "hover:bg-secondary",
						)}
						onClick={() => setScope(provider)}
					>
						<ProviderLogo provider={provider} className="size-3.5" />
						{provider === "kiro" || provider === "opencode" ? (
							<span className="absolute bottom-1 right-1 size-1.5 rounded-full bg-primary" />
						) : null}
					</button>
				))}
			</div>
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="border-b border-border/50 p-2">
					<label className="flex h-7 items-center gap-2 rounded-md bg-background px-2 focus-within:border-foreground/60 focus-within:ring-2 focus-within:ring-primary/30">
						<HugeiconsIcon
							icon={Search01Icon}
							size={14}
							className="text-muted-foreground"
						/>
						<span className="sr-only">{t("demo:search_models")}</span>
						<input
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={
								scope === "all"
									? t("demo:search_models_2", { value0: getModels(t).length })
									: t("demo:in", { value0: providerMeta[scope].label })
							}
							className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
						/>
					</label>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
					{grouped.length > 0 ? (
						<>
							<ModelSectionLabel title={t("demo:models_2")} />
							{grouped.map((group) => (
								<div
									key={group.provider}
									className="border-t border-border/50 py-1 first:border-t-0 first:pt-0"
								>
									<div className="flex items-center gap-2 px-2 py-1 text-[11px]">
										<ProviderLogo
											provider={group.provider}
											className="size-3.5"
										/>
										<span className="font-medium">
											{providerMeta[group.provider].label}
										</span>
										{group.provider === activeModel.provider ? (
											<span className="rounded bg-primary/15 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-primary">
												{t("demo:current")}
											</span>
										) : null}
										<span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
											{group.models.length}
										</span>
									</div>
									<div className="flex flex-col gap-0.5">
										{group.models.map((model) => (
											<DemoModelRow
												key={model.id}
												model={model}
												active={model.id === activeModel.id}
												onSelect={onSelect}
											/>
										))}
									</div>
								</div>
							))}
						</>
					) : (
						<div className="px-3 py-8 text-center text-xs text-muted-foreground">
							{t("demo:no_models_match")}
						</div>
					)}
				</div>
				<div className="shrink-0 px-2 pt-2 pb-2">
					<div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
						<span>{t("demo:advanced")}</span>
						<span className="flex items-center gap-2">
							{reasoningLabel(reasoning, t)}
							<HugeiconsIcon icon={FlashIcon} size={14} />
						</span>
					</div>
					<div className="relative flex h-7 items-center">
						<div
							aria-hidden="true"
							className="pointer-events-none absolute inset-x-0 h-4 overflow-hidden rounded-full bg-secondary"
						>
							<div
								className="h-full bg-primary"
								style={{
									width: `${(REASONING_LEVELS.indexOf(reasoning) / (REASONING_LEVELS.length - 1)) * 100}%`,
								}}
							/>
						</div>
						<div
							aria-hidden="true"
							className="pointer-events-none absolute inset-x-2 flex justify-between"
						>
							{REASONING_LEVELS.map((level) => (
								<span
									key={level}
									className="size-1.5 rounded-full bg-muted-foreground/60"
								/>
							))}
						</div>
						<input
							type="range"
							aria-label={t("demo:reasoning")}
							aria-valuetext={reasoningLabel(reasoning, t)}
							min={0}
							max={REASONING_LEVELS.length - 1}
							step={1}
							value={REASONING_LEVELS.indexOf(reasoning)}
							onChange={(event) =>
								onReasoningChange(REASONING_LEVELS[Number(event.target.value)])
							}
							className="relative h-7 w-full cursor-pointer appearance-none rounded-full bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card [&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-primary [&::-webkit-slider-thumb]:bg-white [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-primary [&::-moz-range-thumb]:bg-white"
						/>
					</div>
				</div>
			</div>
		</div>
	);
}

function ModelSectionLabel({ title, meta }: { title: string; meta?: string }) {
	return (
		<div className="flex items-baseline justify-between px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
			<span>{title}</span>
			{meta ? (
				<span className="text-[9px] normal-case tracking-normal opacity-70">
					{meta}
				</span>
			) : null}
		</div>
	);
}

function DemoModelRow({
	model,
	active,
	onSelect,
}: {
	model: DemoModel;
	active: boolean;
	onSelect: (model: DemoModel) => void;
}) {
	return (
		<button
			type="button"
			aria-current={active || undefined}
			className={cn(
				"group relative flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
				active
					? "bg-primary/15 text-foreground ring-1 ring-primary/20"
					: "hover:bg-secondary",
			)}
			onClick={() => onSelect(model)}
		>
			{active ? (
				<span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
			) : null}
			<ProviderLogo provider={model.provider} className="size-3.5 shrink-0" />
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate font-medium leading-snug">{model.label}</span>
			</span>
			{active && (
				<HugeiconsIcon
					icon={Tick02Icon}
					size={14}
					className="shrink-0 text-primary"
				/>
			)}
			{model.context !== "200K" && (
				<span className="rounded bg-secondary px-1.5 py-px text-[10px] text-muted-foreground">
					{model.context}
				</span>
			)}
		</button>
	);
}

function MenuPanel({
	children,
	side,
	className,
	anchorId,
}: {
	children: ReactNode;
	side: "left" | "right";
	className?: string;
	anchorId: MenuName;
}) {
	const [host, setHost] = useState<HTMLSpanElement | null>(null);
	const boundary = host?.closest("[data-zuse-demo]");
	const anchor = boundary?.querySelector<HTMLElement>(
		`[data-demo-menu-trigger="${anchorId}"]`,
	);
	return (
		<span ref={setHost} className="contents">
			<Popover.Root open={!!anchor}>
				<Popover.Portal container={host}>
					<Popover.Positioner
						anchor={anchor}
						side="top"
						align={side === "right" ? "end" : "start"}
						sideOffset={6}
						collisionBoundary={boundary ?? undefined}
						collisionPadding={8}
						className="z-50"
					>
						<Popover.Popup
							role="menu"
							initialFocus={false}
							finalFocus={false}
							className={cn(
								"max-w-[var(--available-width)] rounded-lg border border-border bg-[var(--popover)] p-1 text-foreground shadow-xl outline-none",
								className,
							)}
						>
							{children}
						</Popover.Popup>
					</Popover.Positioner>
				</Popover.Portal>
			</Popover.Root>
		</span>
	);
}

function MenuRow({
	children,
	icon,
	selected = false,
	meta,
	onClick,
}: {
	children: ReactNode;
	icon: ReactNode;
	selected?: boolean;
	meta?: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			role="menuitem"
			className={cn(
				"grid h-7 w-full grid-cols-[0.875rem_auto_1fr_auto] items-center gap-x-1.5 rounded-md px-2 text-left text-xs hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
				selected && "bg-secondary",
			)}
			onClick={onClick}
		>
			<span className="flex items-center justify-center">
				{selected ? <HugeiconsIcon icon={Tick02Icon} size={14} /> : null}
			</span>
			<span className="text-muted-foreground">{icon}</span>
			<span className="truncate">{children}</span>
			{meta ? (
				<span className="truncate text-[10px] text-muted-foreground">
					{meta}
				</span>
			) : null}
		</button>
	);
}

function IconButton({
	children,
	label,
	pressed,
	onClick,
	className,
}: {
	children: ReactNode;
	label: string;
	pressed?: boolean;
	onClick?: () => void;
	className?: string;
}) {
	const tooltipId = useId();
	return (
		<button
			type="button"
			aria-label={label}
			aria-describedby={tooltipId}
			aria-pressed={pressed}
			onClick={onClick}
			className={cn(
				"group relative flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
				className,
			)}
		>
			{children}
			<span
				id={tooltipId}
				role="tooltip"
				className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-card px-2 py-1 text-[10px] text-foreground shadow-lg group-hover:block group-focus-visible:block"
			>
				{label}
			</span>
		</button>
	);
}

function reasoningLabel(value: string, t: WebsiteMessage) {
	return value === "Low"
		? t("demo:reasoning_low")
		: value === "Medium"
			? t("demo:reasoning_medium")
			: value === "High"
				? t("demo:reasoning_high")
				: value;
}
