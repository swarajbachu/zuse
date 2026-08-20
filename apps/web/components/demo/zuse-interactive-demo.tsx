"use client";

import {
	DitherAvatar,
	DitherButton,
	DitherWaveBackground,
} from "@repo/ui/dither";
import {
	IconArrowUp,
	IconBolt,
	IconBrain,
	IconCheck,
	IconChevronDown,
	IconCloud,
	IconCode,
	IconDeviceDesktop,
	IconEdit,
	IconFolder,
	IconFolderPlus,
	IconGitBranch,
	IconGitPullRequest,
	IconLayoutSidebarLeftCollapse,
	IconLayoutSidebarLeftExpand,
	IconMap,
	IconMoon,
	IconPaperclip,
	IconPlus,
	IconSearch,
	IconSettings,
	IconSun,
	IconX,
} from "@tabler/icons-react";
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

type MenuName = "project" | "environment" | "source" | "model" | "reasoning";
type Provider = "claude" | "codex" | "kiro" | "opencode";
type Environment = "local" | "cloud";

type DemoModel = {
	id: string;
	provider: Provider;
	label: string;
	context: string;
	badge?: string;
};

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

const models: DemoModel[] = [
	{
		id: "gpt-5.6-sol",
		provider: "codex",
		label: "GPT-5.6 Sol",
		context: "1M",
		badge: "Default",
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

const sidebarProjects = [
	{
		name: "zuse",
		chats: [
			{ title: "New chat", additions: "+4", deletions: "−8" },
			{ title: "Polish the chat landing", additions: "+151", deletions: "−9" },
		],
	},
	{
		name: "forkzero",
		chats: [
			{
				title: "Implement cloud environments",
				additions: "+79",
				deletions: "−1",
			},
			{ title: "Fix composer focus", additions: "+45", deletions: "−4" },
			{ title: "Review current changes", additions: "+101", deletions: "−10" },
		],
	},
	{ name: "server", chats: [] },
	{ name: "mobile", chats: [] },
	{ name: "marketing-site", chats: [] },
	{ name: "desktop", chats: [] },
	{ name: "docs", chats: [] },
] as const;

const sourceRows = {
	prs: [
		{ label: "#248 Polish the chat landing", meta: "14m" },
		{ label: "#244 Add cloud environments", meta: "2h" },
	],
	branches: [
		{ label: "feature/chat-landing", meta: "3 ahead" },
		{ label: "fix/composer-focus", meta: "1 ahead" },
	],
	issues: [
		{ label: "ZUS-184 Composer polish", meta: "High" },
		{ label: "ZUS-179 Cloud reconnect", meta: "Medium" },
	],
};

const continueThreads = [
	{
		title: "Improve the chat landing background",
		preview:
			"Keep the renderer composer unchanged and add the visual treatment behind it.",
		project: "zuse",
		time: "now",
	},
	{
		title: "Generate a concise semantic branch name",
		preview:
			"Use the current diff and return a short branch name for the following task.",
		project: "forkzero",
		time: "8m",
	},
	{
		title: "Review the current implementation",
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
	const [theme, setTheme] = useState<"light" | "dark">("dark");
	const [project, setProject] = useState("forkzero");
	const [environment, setEnvironment] = useState<Environment>("local");
	const [expandedProjects, setExpandedProjects] = useState(
		() => new Set(["forkzero"]),
	);
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [modelId, setModelId] = useState("gpt-5.6-sol");
	const [reasoning, setReasoning] = useState("Medium");
	const [planMode, setPlanMode] = useState(false);
	const [menu, setMenu] = useState<MenuName | null>(null);
	const [sourceTab, setSourceTab] = useState<keyof typeof sourceRows>("prs");
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

	const activeModel = models.find((entry) => entry.id === modelId) ?? models[0];
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
				.zuse-composer-glass {
					background: color-mix(in oklab, var(--secondary) 82%, transparent);
					backdrop-filter: blur(20px) saturate(1.05);
				}
				[data-theme="dark"] .zuse-composer-glass {
					background: color-mix(in oklab, var(--secondary) 72%, transparent);
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
					<DitherWaveBackground
						className="pointer-events-none absolute inset-x-0 bottom-0 h-[52%] opacity-95 dark:opacity-80"
						color={[165, 205, 65]}
						pixelSize={3}
						waveAmplitude={0.25}
						waveFrequency={2.6}
						disableAnimation
						enableMouseInteraction={false}
					/>

					{!sidebarOpen ? (
						<button
							type="button"
							aria-label="Show projects panel"
							className="absolute left-2 top-2 z-30 flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
							onClick={() => setSidebarOpen(true)}
						>
							<IconLayoutSidebarLeftExpand size={16} />
						</button>
					) : null}

					<button
						type="button"
						aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
						className="absolute right-2 top-2 z-30 flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary md:hidden"
						onClick={() =>
							setTheme((current) => (current === "dark" ? "light" : "dark"))
						}
					>
						{theme === "dark" ? <IconSun size={16} /> : <IconMoon size={16} />}
					</button>

					<main className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-12 sm:px-6">
						<div
							ref={shellRef}
							className="flex w-full max-w-3xl flex-col gap-4"
						>
							<ComposerHeading className="text-center text-xl font-medium text-foreground/90">
								What should we build in {project}?
							</ComposerHeading>

							<form onSubmit={submit} className="w-full">
								<div className="zuse-composer-glass relative flex flex-col rounded-lg p-1">
									<div className="mb-1 flex h-8 items-center justify-between gap-2 px-1">
										<div className="flex min-w-0 items-center gap-1">
											<CompactMenuButton
												label={project}
												ariaLabel="Pick a project"
												icon={<IconFolder size={14} />}
												open={menu === "project"}
												onClick={() =>
													setMenu(menu === "project" ? null : "project")
												}
											/>
											<CompactMenuButton
												label={environment === "local" ? "Local" : "Cloud"}
												ariaLabel="Choose local or cloud environment"
												icon={
													environment === "local" ? (
														<IconDeviceDesktop size={14} />
													) : (
														<IconCloud size={14} />
													)
												}
												open={menu === "environment"}
												onClick={() =>
													setMenu(menu === "environment" ? null : "environment")
												}
											/>
										</div>
										<div className="flex min-w-0 items-center gap-1.5">
											{source !== null ? (
												<span className="hidden min-w-0 items-center gap-1 rounded-md bg-secondary/80 py-1 pl-2 pr-1 text-[11px] text-muted-foreground sm:flex">
													<span className="max-w-40 truncate">{source}</span>
													<button
														type="button"
														aria-label="Clear create-from source"
														className="rounded p-1 hover:bg-card hover:text-foreground"
														onClick={() => setSource(null)}
													>
														<IconX size={12} />
													</button>
												</span>
											) : null}
											<CompactMenuButton
												label="Create from…"
												ariaLabel="Create from an existing PR, branch, or issue"
												icon={<IconGitPullRequest size={14} />}
												open={menu === "source"}
												collapseOnMobile
												onClick={() =>
													setMenu(menu === "source" ? null : "source")
												}
											/>
										</div>

										{menu === "project" ? (
											<MenuPanel side="left" className="top-9 w-64">
												{sidebarProjects.map((entry) => (
													<MenuRow
														key={entry.name}
														selected={entry.name === project}
														icon={<IconFolder size={14} />}
														onClick={() => selectProject(entry.name)}
													>
														{entry.name}
													</MenuRow>
												))}
												<div className="my-1 h-px bg-border" />
												<MenuRow
													icon={<IconPlus size={14} />}
													onClick={() => setMenu(null)}
												>
													Add project…
												</MenuRow>
											</MenuPanel>
										) : null}

										{menu === "environment" ? (
											<MenuPanel side="left" className="top-9 left-24 w-60">
												<MenuRow
													selected={environment === "local"}
													icon={<IconDeviceDesktop size={14} />}
													meta="This Mac"
													onClick={() => {
														setEnvironment("local");
														setMenu(null);
													}}
												>
													Local workspace
												</MenuRow>
												<MenuRow
													selected={environment === "cloud"}
													icon={<IconCloud size={14} />}
													meta="Live beta"
													onClick={() => {
														setEnvironment("cloud");
														setMenu(null);
													}}
												>
													Cloud workspace
												</MenuRow>
											</MenuPanel>
										) : null}

										{menu === "source" ? (
											<MenuPanel
												side="right"
												className="top-9 w-[min(30rem,calc(100vw-2rem))] overflow-hidden p-0"
											>
												<div className="flex items-center gap-2 border-b border-border px-3 py-2">
													<IconSearch
														size={16}
														className="text-muted-foreground"
													/>
													<input
														aria-label="Search create-from sources"
														placeholder="Search by title, number, or author"
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
																{tab === "prs" ? "Pull requests" : tab}
															</button>
														),
													)}
												</div>
												<div className="p-1">
													{sourceRows[sourceTab].map((row) => (
														<MenuRow
															key={row.label}
															icon={
																sourceTab === "branches" ? (
																	<IconGitBranch size={14} />
																) : sourceTab === "issues" ? (
																	<IconBolt size={14} />
																) : (
																	<IconGitPullRequest size={14} />
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
											"relative min-h-30 rounded-lg border bg-card transition-colors dark:bg-transparent",
											planMode
												? "border-2 border-dashed border-rose-300/50"
												: "border-border/60",
										)}
									>
										<textarea
											value={prompt}
											onChange={(event) => setPrompt(event.target.value)}
											onKeyDown={(event) => {
												if (event.key === "Enter" && !event.shiftKey) {
													event.preventDefault();
													event.currentTarget.form?.requestSubmit();
												}
											}}
											aria-label="Message"
											placeholder="Ask to make changes at the @ mentioned files or run slash commands, shift enter for next line."
											className="min-h-30 w-full resize-none bg-transparent px-3 py-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/75"
										/>
									</div>

									<div className="relative flex h-11 items-center justify-between gap-2 px-2 py-1.5">
										<div className="flex min-w-0 items-center gap-0.5 sm:gap-1.5">
											<IconButton label="Attach files">
												<IconPaperclip size={15} />
											</IconButton>
											<button
												type="button"
												aria-label="Change model"
												aria-expanded={menu === "model"}
												className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
												onClick={() =>
													setMenu(menu === "model" ? null : "model")
												}
											>
												<ProviderLogo
													provider={activeModel.provider}
													className="size-3.5"
												/>
												<span>{activeModel.label}</span>
												<IconChevronDown size={12} className="opacity-60" />
											</button>
											<button
												type="button"
												aria-label="Reasoning"
												className="hidden h-7 items-center gap-1.5 rounded-md px-2.5 text-xs text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary min-[430px]:flex"
												onClick={() =>
													setMenu(menu === "reasoning" ? null : "reasoning")
												}
											>
												<IconBrain size={14} />
												<span>{reasoning}</span>
												<IconChevronDown size={12} className="opacity-60" />
											</button>
											<IconButton
												label={planMode ? "Exit plan mode" : "Enter plan mode"}
												pressed={planMode}
												onClick={() => setPlanMode((current) => !current)}
												className={
													planMode ? "bg-rose-400/15 text-rose-500" : undefined
												}
											>
												<IconMap size={15} />
											</IconButton>
											<IconButton label="MCP servers">
												<IconCode size={15} />
											</IconButton>
										</div>
										<DitherButton
											type="submit"
											variant="gradient"
											aria-label="Send"
											disabled={prompt.trim().length === 0 || submitted}
											className="size-7 shrink-0 border border-primary/40 text-white active:scale-95 focus-visible:ring-offset-1"
										>
											{submitted ? (
												<span className="zuse-demo-pulse size-2 animate-pulse rounded-full bg-current" />
											) : (
												<IconArrowUp size={15} strokeWidth={2.2} />
											)}
										</DitherButton>

										{menu === "model" ? (
											<DemoModelPicker
												activeModel={activeModel}
												onSelect={(next) => {
													setModelId(next.id);
													setMenu(null);
												}}
											/>
										) : null}
										{menu === "reasoning" ? (
											<MenuPanel side="left" className="bottom-11 left-52 w-44">
												<p className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
													Reasoning
												</p>
												{["Low", "Medium", "High", "Ultracode"].map((entry) => (
													<MenuRow
														key={entry}
														selected={entry === reasoning}
														icon={<IconBrain size={14} />}
														onClick={() => {
															setReasoning(entry);
															setMenu(null);
														}}
													>
														{entry}
													</MenuRow>
												))}
											</MenuPanel>
										) : null}
									</div>
								</div>
							</form>

							<ContinueThreads />
							<div
								aria-live="polite"
								className="h-4 text-center text-xs text-muted-foreground"
							>
								{submitted
									? `Starting ${providerMeta[activeModel.provider].label} in ${project} on ${environment === "local" ? "this Mac" : "a cloud workspace"}…`
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
	return (
		<aside className="hidden h-full min-h-0 w-[232px] shrink-0 flex-col border-r border-border bg-secondary/45 text-foreground md:flex">
			<header className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3 text-[11px]">
				<span className="truncate font-semibold tracking-tight">
					Zuse (Beta)
				</span>
				<span className="flex-1" />
				<button
					type="button"
					aria-label="Hide projects panel"
					className="flex size-7 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
					onClick={onClose}
				>
					<IconLayoutSidebarLeftCollapse size={15} />
				</button>
			</header>
			<div className="flex flex-col gap-0.5 border-b border-border px-1.5 py-1.5">
				<SidebarAction
					icon={<IconEdit size={16} />}
					label="New chat"
					shortcut="⌘ N"
				/>
				<SidebarAction
					icon={<IconFolderPlus size={16} />}
					label="New project"
				/>
			</div>
			<div className="flex items-center justify-between px-2.5 py-1.5 text-[12px] text-muted-foreground">
				<span>Projects</span>
				<button
					type="button"
					aria-label="Add project"
					className="flex size-7 items-center justify-center rounded-md hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
				>
					<IconPlus size={14} />
				</button>
			</div>
			<ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
				{sidebarProjects.map((entry) => {
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
											"grid size-5 shrink-0 place-items-center rounded bg-card/75 ring-1 ring-border/55",
											entry.name === project && "bg-primary/10 ring-primary/25",
										)}
									>
										<DitherAvatar
											name={entry.name}
											size={13}
											hue={entry.name === project ? 78 : undefined}
										/>
									</span>
									<span className="min-w-0 flex-1 truncate text-[12px]">
										{entry.name}
									</span>
								</button>
								<button
									type="button"
									aria-label={`Settings for ${entry.name}`}
									className="rounded p-1 text-muted-foreground opacity-0 hover:bg-card hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
								>
									<IconSettings size={14} />
								</button>
								<button
									type="button"
									aria-label={`New chat in ${entry.name}`}
									className="rounded p-1 text-muted-foreground opacity-0 hover:bg-card hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
								>
									<IconEdit size={14} />
								</button>
							</div>
							{expanded && entry.chats.length > 0 ? (
								<ul aria-label={`${entry.name} chats`}>
									{entry.chats.map((chat) => (
										<li key={chat.title}>
											<button
												type="button"
												className="group flex min-h-7 w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] text-muted-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
											>
												<IconGitBranch
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
					Zuse workspace
				</span>
				<button
					type="button"
					aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
					className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
					onClick={onToggleTheme}
				>
					{theme === "dark" ? <IconSun size={15} /> : <IconMoon size={15} />}
				</button>
			</div>
		</aside>
	);
}

function ContinueThreads() {
	return (
		<section className="mt-2 min-w-0">
			<div className="mb-2 flex items-center gap-2 px-1 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
				<span>Continue Threads</span>
				<span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] tracking-normal">
					{continueThreads.length}
				</span>
			</div>
			<div className="flex gap-3 overflow-x-auto pb-1">
				{continueThreads.map((thread) => (
					<button
						type="button"
						key={thread.title}
						className="group min-w-[17.5rem] max-w-[19rem] text-left outline-none focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-primary"
					>
						<div className="flex h-40 min-w-[17.5rem] flex-col rounded-lg bg-secondary p-1">
							<div className="flex items-center justify-between gap-2 px-3 py-1.5">
								<span className="flex min-w-0 items-center gap-1.5">
									<span className="flex size-7 items-center justify-center rounded-md bg-background">
										<ProviderLogo provider="codex" className="size-4" />
									</span>
									<span className="text-[11px] font-medium text-muted-foreground">
										Codex
									</span>
								</span>
								<span className="text-[11px] text-muted-foreground">
									{thread.time}
								</span>
							</div>
							<div className="min-h-0 flex-1 rounded-md border border-border/70 bg-card/60 px-3 py-2">
								<div className="line-clamp-2 text-[13px] font-medium leading-snug">
									{thread.title}
								</div>
								<div className="mt-1.5 line-clamp-2 text-[12px] leading-snug text-muted-foreground">
									{thread.preview}
								</div>
							</div>
							<div className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-muted-foreground">
								<IconFolder size={14} />
								<span className="truncate">{thread.project}</span>
							</div>
						</div>
					</button>
				))}
			</div>
		</section>
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
	label,
	ariaLabel,
	icon,
	open,
	collapseOnMobile = false,
	onClick,
}: {
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
			aria-label={ariaLabel}
			aria-expanded={open}
			className={cn(
				"flex h-7 min-w-0 max-w-44 items-center gap-1.5 rounded-md border border-border bg-secondary px-2 text-[11px] text-foreground hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
				collapseOnMobile && "max-sm:w-8 max-sm:px-2",
			)}
			onClick={onClick}
		>
			<span className="shrink-0 text-muted-foreground">{icon}</span>
			<span className={cn("truncate", collapseOnMobile && "max-sm:sr-only")}>
				{label}
			</span>
			<IconChevronDown
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
	onSelect,
}: {
	activeModel: DemoModel;
	onSelect: (model: DemoModel) => void;
}) {
	const [scope, setScope] = useState<Provider | "all">("all");
	const [query, setQuery] = useState("");
	const visibleModels = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		return models.filter(
			(model) =>
				(scope === "all" || model.provider === scope) &&
				(normalized.length === 0 ||
					model.label.toLowerCase().includes(normalized) ||
					providerMeta[model.provider].label
						.toLowerCase()
						.includes(normalized)),
		);
	}, [query, scope]);
	const grouped = (Object.keys(providerMeta) as Provider[])
		.map((provider) => ({
			provider,
			models: visibleModels.filter((model) => model.provider === provider),
		}))
		.filter((group) => group.models.length > 0);
	const recents = models
		.filter((model) => [activeModel.id, "sonnet-5"].includes(model.id))
		.filter((model) => scope === "all" || model.provider === scope)
		.filter((model) =>
			visibleModels.some((visible) => visible.id === model.id),
		);

	return (
		<div
			role="dialog"
			aria-label="Choose a model"
			className="absolute bottom-11 left-0 z-50 flex h-[min(430px,70vh)] w-[min(430px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-card/95 text-foreground shadow-[0_18px_50px_rgba(0,0,0,0.22)] backdrop-blur-xl sm:left-10"
		>
			<div
				role="tablist"
				aria-label="Model provider"
				className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border/50 bg-secondary/40 p-1.5"
			>
				<button
					type="button"
					role="tab"
					aria-selected={scope === "all"}
					aria-label="All models"
					className={cn(
						"flex size-8 items-center justify-center rounded-md text-[10px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
						scope === "all"
							? "bg-primary/15 text-foreground ring-1 ring-primary/20"
							: "text-muted-foreground hover:bg-secondary hover:text-foreground",
					)}
					onClick={() => setScope("all")}
				>
					All
				</button>
				{(Object.keys(providerMeta) as Provider[]).map((provider) => (
					<button
						key={provider}
						type="button"
						role="tab"
						aria-selected={scope === provider}
						aria-label={`${providerMeta[provider].label} models`}
						title={`${providerMeta[provider].label} models`}
						className={cn(
							"relative flex size-8 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
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
				<div className="border-b border-border/50 p-2.5">
					<label className="flex min-h-10 items-center gap-2 rounded-lg border border-border bg-background px-3 focus-within:border-foreground/60 focus-within:ring-2 focus-within:ring-primary/30">
						<IconSearch size={14} className="text-muted-foreground" />
						<span className="sr-only">Search models</span>
						<input
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={
								scope === "all"
									? `Search ${models.length} models`
									: `in ${providerMeta[scope].label}…`
							}
							className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
						/>
					</label>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2.5">
					{recents.length > 0 ? (
						<>
							<ModelSectionLabel title="Recents" meta="last 30 days" />
							<div className="flex flex-col gap-0.5">
								{recents.map((model, index) => (
									<DemoModelRow
										key={`recent-${model.id}`}
										model={model}
										active={model.id === activeModel.id}
										shortcut={index + 1}
										onSelect={onSelect}
										showProvider
									/>
								))}
							</div>
						</>
					) : null}
					{grouped.length > 0 ? (
						<>
							<ModelSectionLabel title="Models" />
							{grouped.map((group) => (
								<div
									key={group.provider}
									className="border-t border-border/50 py-2 first:border-t-0 first:pt-0"
								>
									<div className="flex items-center gap-2 px-2 pb-1 pt-1.5 text-xs">
										<ProviderLogo
											provider={group.provider}
											className="size-3.5"
										/>
										<span className="font-medium">
											{providerMeta[group.provider].label}
										</span>
										{group.provider === activeModel.provider ? (
											<span className="rounded bg-primary/15 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-primary">
												Current
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
							No models match.
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function ModelSectionLabel({ title, meta }: { title: string; meta?: string }) {
	return (
		<div className="flex items-baseline justify-between px-2 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
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
	shortcut,
	showProvider = false,
	onSelect,
}: {
	model: DemoModel;
	active: boolean;
	shortcut?: number;
	showProvider?: boolean;
	onSelect: (model: DemoModel) => void;
}) {
	return (
		<button
			type="button"
			aria-current={active || undefined}
			className={cn(
				"group relative flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
				active
					? "bg-primary/15 text-foreground ring-1 ring-primary/20"
					: "hover:bg-secondary",
			)}
			onClick={() => onSelect(model)}
		>
			{active ? (
				<span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
			) : null}
			<ProviderLogo provider={model.provider} className="size-4 shrink-0" />
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="font-medium leading-snug">{model.label}</span>
				{showProvider ? (
					<span className="text-[11px] text-muted-foreground">
						{providerMeta[model.provider].label}
					</span>
				) : null}
			</span>
			<span className="rounded bg-secondary px-1.5 py-px text-[10px] text-muted-foreground">
				{model.context}
			</span>
			{model.badge ? (
				<span className="hidden text-[10px] text-muted-foreground sm:inline">
					{model.badge}
				</span>
			) : null}
			{shortcut ? (
				<kbd className="hidden font-sans text-[10px] text-muted-foreground sm:inline">
					⌘{shortcut}
				</kbd>
			) : null}
		</button>
	);
}

function MenuPanel({
	children,
	side,
	className,
}: {
	children: ReactNode;
	side: "left" | "right";
	className?: string;
}) {
	return (
		<div
			role="menu"
			className={cn(
				"absolute z-50 rounded-lg border border-border bg-card/95 p-1 text-foreground shadow-[0_18px_50px_rgba(0,0,0,0.18)] backdrop-blur-xl",
				side === "right" ? "right-1" : "left-1",
				className,
			)}
		>
			{children}
		</div>
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
				"grid min-h-10 w-full grid-cols-[1rem_auto_1fr_auto] items-center gap-x-2 rounded-md px-2 text-left text-sm hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
				selected && "bg-secondary",
			)}
			onClick={onClick}
		>
			<span className="flex items-center justify-center">
				{selected ? <IconCheck size={14} /> : null}
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
