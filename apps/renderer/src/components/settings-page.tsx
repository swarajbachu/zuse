import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Alert01Icon,
	ArrowLeft01Icon,
	BrowserIcon,
	ConnectIcon,
	Delete02Icon,
	DocumentAttachmentIcon,
	Folder01Icon,
	InformationCircleIcon,
	KeyboardIcon,
	PackageIcon,
	PencilEdit01Icon,
	PlugSocketIcon,
	Settings01Icon,
	SmartPhone01Icon,
	TaskDone01Icon,
	TestTubeIcon,
	Tick01Icon,
	VolumeHighIcon,
} from "@hugeicons-pro/core-solid-rounded";
import {
	type AppearanceMode,
	type BranchNamingStyle,
	type CompletionSoundPreset,
	type Folder,
	type FolderId,
	MODELS_BY_PROVIDER,
	type ProviderId,
	type RuntimeMode,
	visibleModelsForProvider,
} from "@zuse/contracts";
import { Effect } from "effect";
import { Plus, RefreshCw as RefreshIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { displayPath } from "~/lib/display-path";
import { isInitialProviderAvailabilityLoading } from "~/lib/provider-status";

import {
	formatRelativeTime,
	useRelativeTimeTick,
} from "~/lib/use-relative-time.ts";
import { cn } from "~/lib/utils";
import { useAuth } from "../hooks/use-auth.ts";
import type { BrowserCookieImportStatus } from "../lib/bridge.ts";
import {
	COMPLETION_SOUND_PRESETS,
	playCompletionSound,
	prepareCompletionSound,
} from "../lib/completion-sounds.ts";
import { collectDiagnosticsClientContext } from "../lib/diagnostics-client-context.ts";
import { recordUiAction } from "../lib/diagnostics-recorder.ts";
import {
	openExternal as openExternalUrl,
	rendererPlatformCapabilities,
} from "../lib/platform-capabilities.ts";
import { PROVIDER_LABEL } from "../lib/provider-labels.ts";
import { getRpcClient } from "../lib/rpc-client.ts";
import { useProvidersStore } from "../store/providers.ts";
import { useSettingsStore } from "../store/settings.ts";
import { type SettingsSection, useUiStore } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { BlurredEmail } from "./blurred-email.tsx";
import { BrowserProfileSelect } from "./browser-profile-select.tsx";
import { ProviderCard } from "./provider-card.tsx";
import { ProviderIcon } from "./provider-icons.tsx";
import { MODE_META, MODES_ORDER } from "./runtime-mode-meta.ts";
import { DeveloperPane } from "./settings/developer-pane.tsx";
import { DevicesPane } from "./settings/devices-pane.tsx";
import { KeybindingsPane } from "./settings/keybindings-editor.tsx";
import { LinearIntegrationsPane } from "./settings/linear-integrations-pane.tsx";
import { McpServersPane } from "./settings/mcp-servers-pane.tsx";
import { PokedexPane } from "./settings/pokedex-pane.tsx";
import { RepositorySettings } from "./settings-repository.tsx";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar.tsx";
import { Button } from "./ui/button.tsx";
import { Card } from "./ui/card.tsx";
import { Frame, FrameFooter, FrameHeader } from "./ui/frame.tsx";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "./ui/select.tsx";
import { Switch } from "./ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

type RailItemBase = {
	readonly id: string;
	readonly label: string;
	readonly Icon: IconSvgElement;
	readonly section: SettingsSection;
};

const TOP_RAIL: ReadonlyArray<RailItemBase> = [
	{
		id: "general",
		label: "General",
		Icon: Settings01Icon,
		section: { kind: "general" },
	},
	{
		id: "providers",
		label: "Providers",
		Icon: PackageIcon,
		section: { kind: "providers" },
	},
	{
		id: "mcp",
		label: "MCP Servers",
		Icon: PlugSocketIcon,
		section: { kind: "mcp" },
	},
	{
		id: "integrations",
		label: "Integrations",
		Icon: ConnectIcon,
		section: { kind: "integrations" },
	},
	{
		id: "devices",
		label: "Devices",
		Icon: SmartPhone01Icon,
		section: { kind: "devices" },
	},
	{
		id: "browser",
		label: "Browser",
		Icon: BrowserIcon,
		section: { kind: "browser" },
	},
	{
		id: "pokedex",
		label: "Pokedex",
		Icon: TaskDone01Icon,
		section: { kind: "pokedex" },
	},
	{
		id: "shortcuts",
		label: "Keyboard shortcuts",
		Icon: KeyboardIcon,
		section: { kind: "shortcuts" },
	},
	{
		id: "advanced",
		label: "Advanced",
		Icon: DocumentAttachmentIcon,
		section: { kind: "advanced" },
	},
	// Dev-only visual playground (accent swatches + workflow chip/button
	// showcase). Filtered out of production bundles below.
	{
		id: "developer",
		label: "Developer",
		Icon: TestTubeIcon,
		section: { kind: "developer" },
	},
];

const VISIBLE_RAIL: ReadonlyArray<RailItemBase> = import.meta.env.DEV
	? TOP_RAIL
	: TOP_RAIL.filter((i) => i.id !== "developer");

/**
 * Two-pane settings surface. The left rail navigates between global
 * sections (General / Models & Providers / Workspace) and per-repository
 * settings; the right pane renders the active section's form.
 */
export function SettingsPage() {
	const setView = useUiStore((s) => s.setView);
	const section = useUiStore((s) => s.settingsSection);
	const setSection = useUiStore((s) => s.setSettingsSection);
	const folders = useWorkspaceStore((s) => s.folders);
	const loadFolders = useWorkspaceStore((s) => s.load);

	useEffect(() => {
		if (folders.length === 0) void loadFolders();
	}, [folders.length, loadFolders]);

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			<header className="flex h-9 shrink-0 items-center px-3 text-xs text-muted-foreground [-webkit-app-region:drag]">
				<div className="w-16 shrink-0" />
				<button
					type="button"
					onClick={() => setView("chat")}
					aria-label="Back to app"
					className="flex items-center gap-1 rounded p-1 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground [-webkit-app-region:no-drag]"
				>
					<HugeiconsIcon icon={ArrowLeft01Icon} className="size-3.5" />
					<span>Back to app</span>
				</button>
			</header>
			<div className="flex min-h-0 flex-1">
				<Rail section={section} onSelect={setSection} folders={folders} />
				<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-10 py-8">
					<div
						className={cn(
							"mx-auto flex w-full flex-col gap-10",
							section.kind === "pokedex" ? "max-w-5xl" : "max-w-2xl",
						)}
					>
						<SectionTitle section={section} folders={folders} />
						<Pane section={section} />
					</div>
				</div>
			</div>
		</div>
	);
}

function Rail({
	section,
	onSelect,
	folders,
}: {
	section: SettingsSection;
	onSelect: (section: SettingsSection) => void;
	folders: ReadonlyArray<Folder>;
}) {
	return (
		<nav className="flex w-56 shrink-0 flex-col gap-5 border-r border-border/40 bg-sidebar px-2.5 py-4 text-sm text-sidebar-foreground">
			<div className="flex flex-col gap-0.5">
				{VISIBLE_RAIL.map((item) => {
					const active =
						section.kind !== "repository" && section.kind === item.section.kind;
					return (
						<RailButton
							key={item.id}
							active={active}
							onClick={() => onSelect(item.section)}
							icon={item.Icon}
							label={item.label}
						/>
					);
				})}
			</div>
			{folders.length > 0 && (
				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between px-2">
						<span className="text-[11px] font-medium tracking-wide text-muted-foreground/80">
							Repositories
						</span>
						<span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
							{folders.length}
						</span>
					</div>
					<div className="flex flex-col gap-0.5">
						{folders.map((f) => {
							const active =
								section.kind === "repository" && section.projectId === f.id;
							return (
								<RailButton
									key={f.id}
									active={active}
									onClick={() =>
										onSelect({ kind: "repository", projectId: f.id })
									}
									icon={Folder01Icon}
									label={f.name}
									title={displayPath(f.path)}
									truncate
								/>
							);
						})}
					</div>
				</div>
			)}
		</nav>
	);
}

function RailButton({
	active,
	onClick,
	icon: Icon,
	label,
	title,
	truncate,
}: {
	active: boolean;
	onClick: () => void;
	icon: IconSvgElement;
	label: string;
	title?: string;
	truncate?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={title}
			className={cn(
				"flex min-h-7 items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				active
					? "bg-sidebar-accent text-sidebar-accent-foreground"
					: "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
			)}
		>
			<HugeiconsIcon icon={Icon} className="size-4 shrink-0" />
			<span className={cn(truncate && "truncate")}>{label}</span>
		</button>
	);
}

function SectionTitle({
	section,
	folders,
}: {
	section: SettingsSection;
	folders: ReadonlyArray<Folder>;
}) {
	const { title, subtitle } = useMemo(() => {
		if (section.kind === "general") {
			return {
				title: "General",
				subtitle: "Defaults for new chats.",
			};
		}
		if (section.kind === "providers") {
			return {
				title: "Providers",
				subtitle:
					"Verify what's installed, signed in, and which subscription each provider runs on.",
			};
		}
		if (section.kind === "integrations") {
			return {
				title: "Integrations",
				subtitle:
					"Connect issue workspaces and bring tickets into new sessions.",
			};
		}
		if (section.kind === "mcp") {
			return {
				title: "MCP Servers",
				subtitle:
					"Configured servers and provider-managed connectors, with live availability and authentication.",
			};
		}
		if (section.kind === "devices") {
			return {
				title: "Devices",
				subtitle:
					"Link this Mac to your account so you can drive it from your phone.",
			};
		}
		if (section.kind === "browser") {
			return {
				title: "Browser",
				subtitle: "Sessions, password filling, privacy, and agent access.",
			};
		}
		if (section.kind === "pokedex") {
			return {
				title: "Pokedex",
				subtitle: "Unlocked Pokémon from all worktrees.",
			};
		}
		if (section.kind === "advanced") {
			return {
				title: "Advanced",
				subtitle:
					"Browser test logins and diagnostics — settings you rarely need.",
			};
		}
		if (section.kind === "shortcuts") {
			return {
				title: "Keyboard shortcuts",
				subtitle: "These also appear under the menu bar.",
			};
		}
		if (section.kind === "developer") {
			return {
				title: "Developer",
				subtitle:
					"Accent palette + workflow chip/button states (dev builds only).",
			};
		}
		const f = folders.find((x) => x.id === section.projectId);
		return {
			title: f?.name ?? "Repository",
			subtitle: f?.path !== undefined ? displayPath(f.path) : "",
		};
	}, [section, folders]);
	return (
		<div className="flex min-w-0 items-center gap-1.5">
			<h1 className="truncate text-base font-semibold tracking-tight text-foreground">
				{title}
			</h1>
			{subtitle && <InfoTip content={subtitle} />}
		</div>
	);
}

/**
 * Small info affordance carrying explanatory copy that used to render as a
 * visible subtitle/description. Keeps headers to a single clean line.
 */
function InfoTip({ content }: { content: React.ReactNode }) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						tabIndex={-1}
						aria-label="More info"
						className="inline-flex shrink-0 cursor-default items-center text-muted-foreground/50 hover:text-muted-foreground"
					>
						<HugeiconsIcon icon={InformationCircleIcon} className="size-3.5" />
					</button>
				}
			/>
			<TooltipPopup className="max-w-72">{content}</TooltipPopup>
		</Tooltip>
	);
}

function Pane({ section }: { section: SettingsSection }) {
	if (section.kind === "general") return <GeneralPane />;
	if (section.kind === "providers") return <ProvidersPane />;
	if (section.kind === "integrations") return <LinearIntegrationsPane />;
	if (section.kind === "mcp") return <McpServersPane />;
	if (section.kind === "devices") return <DevicesPane />;
	if (section.kind === "browser") return <BrowserSettingsPagePane />;
	if (section.kind === "pokedex") return <PokedexPane />;
	if (section.kind === "advanced") return <AdvancedPane />;
	if (section.kind === "shortcuts") return <KeybindingsPane />;
	if (section.kind === "developer") return <DeveloperPane />;
	return <RepositorySettings projectId={section.projectId} />;
}

const DIAGNOSTICS_ISSUE_URL =
	"https://github.com/swarajbachu/zuse/issues/new?template=bug_report.yml";

function openExternal(url: string): void {
	void openExternalUrl(url);
}

function revealPath(path: string): void {
	const bridge = window.zuse ?? window.memoize;
	void bridge?.app?.revealPath?.(path);
}

async function copyDiagnosticsJson(path: string): Promise<boolean> {
	const bridge = window.zuse ?? window.memoize;
	return (await bridge?.app?.copyFileContents?.(path)) ?? false;
}

function DiagnosticsPane() {
	const capabilities = rendererPlatformCapabilities();
	const [isExporting, setIsExporting] = useState(false);
	const [lastExport, setLastExport] = useState<{
		diagnosticId: string;
		bundlePath: string;
		summary: string;
		jsonCopied: boolean;
		included: ReadonlyArray<string>;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState<"summary" | "json" | null>(null);

	const markCopied = (kind: "summary" | "json") => {
		setCopied(kind);
		window.setTimeout(() => {
			setCopied((current) => (current === kind ? null : current));
		}, 1400);
	};

	const copyText = async (text: string) => {
		await navigator.clipboard?.writeText(text);
		markCopied("summary");
	};

	const copyJson = async (path: string) => {
		const ok = await copyDiagnosticsJson(path);
		if (ok) markCopied("json");
		setLastExport((current) =>
			current && current.bundlePath === path
				? { ...current, jsonCopied: ok }
				: current,
		);
	};

	const exportDiagnostics = async () => {
		setIsExporting(true);
		setError(null);
		try {
			const client = await getRpcClient();
			recordUiAction("diagnostics.export.started");
			const clientContext = await collectDiagnosticsClientContext();
			const result = await Effect.runPromise(
				client["diagnostics.export"]({ clientContext }),
			);
			const jsonCopied = await copyDiagnosticsJson(result.bundlePath);
			if (jsonCopied) markCopied("json");
			recordUiAction("diagnostics.export.completed", result.diagnosticId);
			setLastExport({
				diagnosticId: result.diagnosticId,
				bundlePath: result.bundlePath,
				summary: result.summary,
				jsonCopied,
				included: result.included,
			});
			revealPath(result.bundlePath);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not export diagnostics bundle.",
			);
		} finally {
			setIsExporting(false);
		}
	};

	return (
		<div className="flex flex-col gap-4">
			<SettingsGroup
				title="Bug report diagnostics"
				description={
					capabilities.revealInFileManager
						? "Creates a redacted diagnostics JSON file for a GitHub bug report. Raw prompts and full transcripts are not included by default."
						: "Creates a redacted diagnostics JSON file on the server. Use the desktop app to reveal that server-side file."
				}
			>
				<SettingsRow
					title="Export diagnostics JSON"
					description={
						capabilities.revealInFileManager
							? "Copies the JSON to your clipboard and reveals the file so you can attach it to the GitHub issue."
							: "Exports a redacted JSON file on the connected server."
					}
					action={
						<Button
							size="sm"
							onClick={() => void exportDiagnostics()}
							disabled={isExporting}
						>
							<HugeiconsIcon
								icon={DocumentAttachmentIcon}
								className="size-3.5"
							/>
							{isExporting ? "Exporting..." : "Export diagnostics"}
						</Button>
					}
				/>
				{lastExport && (
					<SettingsRow
						title={`Last export: ${lastExport.diagnosticId}`}
						description={
							lastExport.jsonCopied
								? "Diagnostics JSON copied. Attach the revealed JSON file to the GitHub issue."
								: "Diagnostics exported. Attach the revealed JSON file to the GitHub issue."
						}
					>
						<div className="flex flex-wrap gap-2">
							<Button
								variant="settings"
								size="sm"
								onClick={() => openExternal(DIAGNOSTICS_ISSUE_URL)}
							>
								Open GitHub issue
							</Button>
							{capabilities.copyServerFile && (
								<Button
									variant="settings"
									size="sm"
									onClick={() => void copyJson(lastExport.bundlePath)}
								>
									{copied === "json" ? "Copied" : "Copy diagnostics JSON"}
								</Button>
							)}
							{capabilities.revealInFileManager && (
								<Button
									variant="settings"
									size="sm"
									onClick={() => revealPath(lastExport.bundlePath)}
								>
									Reveal diagnostics file
								</Button>
							)}
							<Button
								variant="settings"
								size="sm"
								onClick={() => void copyText(lastExport.summary)}
							>
								{copied === "summary" ? "Copied" : "Copy summary"}
							</Button>
						</div>
						<p className="mt-3 text-xs text-muted-foreground">
							File: {lastExport.bundlePath}
						</p>
						<div className="mt-3 rounded-lg border border-border/40 bg-background/60 p-3">
							<div className="mb-2 text-xs font-medium text-muted-foreground">
								Bundle contents
							</div>
							<div className="flex flex-wrap gap-1.5">
								{lastExport.included.map((item) => (
									<span
										key={item}
										className="rounded bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
									>
										{item}
									</span>
								))}
							</div>
						</div>
					</SettingsRow>
				)}
				{error && (
					<SettingsRow
						icon={Alert01Icon}
						title="Export failed"
						description={error}
					/>
				)}
			</SettingsGroup>

			<SettingsFrame
				title="Reporting from GitHub?"
				description="Open a bug report, follow the template, export diagnostics from Help -> Export Diagnostics for Bug Report, then attach the JSON file before submitting."
			/>
		</div>
	);
}

const EMPTY_BROWSER_IMPORT_STATUS: BrowserCookieImportStatus = {
	supported: false,
	availableProfiles: [],
	importedDomainCount: 0,
	importedCookieCount: 0,
	importedDomains: [],
	message: "Checking local browser profiles…",
};

function BrowserSettingsPagePane() {
	const [status, setStatus] = useState<BrowserCookieImportStatus>(
		EMPTY_BROWSER_IMPORT_STATUS,
	);
	const [selectedProfileId, setSelectedProfileId] = useState<
		string | undefined
	>();
	const [credentialCapability, setCredentialCapability] = useState<{
		supported: boolean;
		reason?: string;
	} | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [clearOpen, setClearOpen] = useState(false);

	useEffect(() => {
		let cancelled = false;
		const browser = window.zuse?.browser;
		void Promise.all([
			browser?.getCookieImportStatus?.(),
			browser?.getNativeCredentialCapability?.(),
		]).then(([nextStatus, capability]) => {
			if (cancelled) return;
			if (nextStatus !== undefined) setStatus(nextStatus);
			if (capability !== undefined) setCredentialCapability(capability);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		setSelectedProfileId((current) =>
			status.availableProfiles.some((profile) => profile.id === current)
				? current
				: (status.selectedProfileId ?? status.availableProfiles[0]?.id),
		);
	}, [status]);

	const run = async (
		operation: () => Promise<BrowserCookieImportStatus> | undefined,
	): Promise<boolean> => {
		setBusy(true);
		setError(null);
		try {
			const request = operation();
			const next = request === undefined ? undefined : await request;
			if (next === undefined)
				throw new Error(
					"Browser session controls are unavailable in this build.",
				);
			setStatus(next);
			return true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			return false;
		} finally {
			setBusy(false);
		}
	};

	const selectedProfile = status.availableProfiles.find(
		(profile) => profile.id === selectedProfileId,
	);
	const sessionDescription =
		status.importedCookieCount === 0
			? "No browser sessions have been imported."
			: `${status.importedCookieCount} cookies across ${status.importedDomainCount} domains${status.lastImportTime ? ` · Imported ${new Date(status.lastImportTime).toLocaleString()}` : ""}`;

	return (
		<div className="flex flex-col gap-4">
			<SettingsGroup
				title="Browser sessions"
				description="Copy valid cookies from a local browser profile into the built-in browser. Cookie values never enter renderer state, logs, or chat."
			>
				<SettingsRow
					title="Import source"
					description={
						selectedProfile === undefined
							? (status.message ?? "No supported browser profile found.")
							: `Close ${selectedProfile.source} before importing. macOS may request Safe Storage access.`
					}
				>
					<div className="flex flex-wrap items-center gap-2">
						<BrowserProfileSelect
							profiles={status.availableProfiles}
							value={selectedProfileId}
							onValueChange={setSelectedProfileId}
							className="w-full max-w-72 bg-background shadow-none"
						/>
						<Button
							size="sm"
							loading={busy}
							disabled={!status.supported || selectedProfileId === undefined}
							onClick={() =>
								void run(() =>
									window.zuse?.browser?.importCookies?.(selectedProfileId),
								)
							}
						>
							Import
						</Button>
					</div>
				</SettingsRow>
				<SettingsRow
					title="Imported data"
					description={sessionDescription}
					action={
						<Button
							size="sm"
							variant="settings"
							disabled={busy || status.importedCookieCount === 0}
							onClick={() =>
								void run(() => window.zuse?.browser?.clearImportedCookies?.())
							}
						>
							Clear imported
						</Button>
					}
				/>
			</SettingsGroup>

			<SettingsGroup
				title="Passwords and autofill"
				description="Passwords are requested individually for the active website and never bulk imported."
			>
				<SettingsRow
					title="System Passwords"
					description={
						credentialCapability?.supported
							? "Available. Filling uses the macOS system confirmation flow for the active origin."
							: (credentialCapability?.reason ??
								"Checking native password capability…")
					}
				/>
			</SettingsGroup>

			<SettingsGroup
				title="Privacy"
				description="Built-in browser data stays in its dedicated persistent desktop partition."
			>
				<SettingsRow
					title="Browsing data"
					description="Remove cookies, site storage, and cache from the built-in browser without changing other browsers."
					action={
						<Button
							size="sm"
							variant="destructive-outline"
							onClick={() => setClearOpen(true)}
						>
							Clear all…
						</Button>
					}
				/>
			</SettingsGroup>

			{error ? (
				<p className="text-xs text-destructive-foreground">{error}</p>
			) : null}

			<BrowserTestLoginsPane />

			<AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
				<AlertDialogPopup className="max-w-sm rounded-xl">
					<AlertDialogHeader className="gap-1 px-4 pb-3 pt-4">
						<AlertDialogTitle>Clear browsing data?</AlertDialogTitle>
						<AlertDialogDescription className="text-xs">
							This removes cookies, site storage, and cache from the built-in
							browser. Other browsers are unchanged.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter className="px-4 py-2">
						<AlertDialogClose render={<Button size="xs" variant="ghost" />}>
							Cancel
						</AlertDialogClose>
						<Button
							size="xs"
							variant="destructive"
							loading={busy}
							onClick={() =>
								void run(() =>
									window.zuse?.browser?.clearBrowsingData?.(),
								).then((ok) => {
									if (ok) setClearOpen(false);
								})
							}
						>
							Clear data
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</div>
	);
}

interface BrowserCredRow {
	readonly origin: string;
	readonly username: string;
}

/**
 * Browser settings — manage the DUMMY/TEST logins the agent browser autofills
 * via `browser_login`. Passwords go straight to the OS keychain (write-only
 * from here; the list RPC never returns them). The warning banner is
 * load-bearing: real credentials must never live here.
 */
function BrowserTestLoginsPane() {
	const [creds, setCreds] = useState<ReadonlyArray<BrowserCredRow>>([]);
	const [origin, setOrigin] = useState("");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);

	const load = async () => {
		const client = await getRpcClient();
		const list = await Effect.runPromise(client["browser.listCredentials"]({}));
		setCreds(list.map((c) => ({ origin: c.origin, username: c.username })));
	};

	useEffect(() => {
		void load();
	}, []);

	const add = async () => {
		if (origin.trim() === "" || password === "") return;
		setBusy(true);
		try {
			const client = await getRpcClient();
			await Effect.runPromise(
				client["browser.setCredential"]({
					origin: origin.trim(),
					username: username.trim(),
					password,
				}),
			);
			setOrigin("");
			setUsername("");
			setPassword("");
			await load();
		} finally {
			setBusy(false);
		}
	};

	const remove = async (target: string) => {
		const client = await getRpcClient();
		await Effect.runPromise(
			client["browser.removeCredential"]({ origin: target }),
		);
		await load();
	};

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-alert-warning-bg px-3 py-2.5 text-[12px] leading-relaxed text-warning-foreground">
				<HugeiconsIcon icon={Alert01Icon} className="mt-0.5 size-4 shrink-0" />
				<span>
					<strong className="font-semibold">Dummy / test logins only.</strong>{" "}
					Never store a real or production password here. These are for seeded
					accounts on dev and staging sites you ask the agent to verify. The
					agent never sees the password — it's injected straight into the page.
				</span>
			</div>

			<SettingsFrame
				title="Saved logins"
				description="The agent calls browser_login with a site's origin; you'll always be asked to approve before it submits."
			>
				<div className="flex flex-col gap-3">
					{creds.length === 0 ? (
						<p className="text-[13px] text-muted-foreground">
							No saved logins yet.
						</p>
					) : (
						<ul className="flex flex-col divide-y divide-border/40">
							{creds.map((c) => (
								<li
									key={c.origin}
									className="flex items-center gap-3 py-2 first:pt-0 last:pb-0"
								>
									<div className="min-w-0 flex-1">
										<p className="truncate text-[13px] font-medium text-foreground">
											{c.origin}
										</p>
										<p className="truncate text-[12px] text-muted-foreground">
											{c.username || "(no username)"} · ••••••••
										</p>
									</div>
									<button
										type="button"
										onClick={() => void remove(c.origin)}
										aria-label={`Remove login for ${c.origin}`}
										className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
									>
										<HugeiconsIcon icon={Delete02Icon} className="size-3.5" />
									</button>
								</li>
							))}
						</ul>
					)}

					<div className="flex flex-col gap-2 border-t border-border/40 pt-3">
						<CredInput
							placeholder="Origin (https://app.example.com)"
							value={origin}
							onChange={setOrigin}
						/>
						<CredInput
							placeholder="Username / email"
							value={username}
							onChange={setUsername}
						/>
						<CredInput
							placeholder="Password (dummy)"
							value={password}
							onChange={setPassword}
							type="password"
						/>
						<div className="flex justify-end">
							<Button
								size="sm"
								onClick={() => void add()}
								disabled={busy || origin.trim() === "" || password === ""}
							>
								<Plus className="size-3.5" strokeWidth={1.8} />
								Add login
							</Button>
						</div>
					</div>
				</div>
			</SettingsFrame>
		</div>
	);
}

function NotchSettingsPane() {
	const enabled = useSettingsStore((s) => s.notchTrayEnabled);
	const pinned = useSettingsStore((s) => s.notchTrayPinned);
	const setEnabled = useSettingsStore((s) => s.setNotchTrayEnabled);
	const setPinned = useSettingsStore((s) => s.setNotchTrayPinned);
	const [support, setSupport] = useState<{
		supported: boolean;
		reason: "supported" | "not-macos" | "no-notched-display";
	} | null>(null);

	useEffect(() => {
		const notch = window.zuse?.notch ?? window.memoize?.notch;
		let cancelled = false;
		void notch?.getDisplaySupport?.().then((next) => {
			if (!cancelled) setSupport(next);
		});
		const unsubscribe = notch?.onDisplaySupportChanged?.((next) => {
			setSupport(next);
		});
		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, []);

	const supported = support?.supported === true;
	const unsupportedText =
		support?.reason === "not-macos"
			? "Requires macOS and a MacBook display with a notch."
			: "Requires a MacBook display with a notch.";

	return (
		<div className="flex flex-col gap-4">
			{!supported && (
				<div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-alert-warning-bg px-3 py-2.5 text-[12px] leading-relaxed text-warning-foreground">
					<HugeiconsIcon
						icon={Alert01Icon}
						className="mt-0.5 size-4 shrink-0"
					/>
					<span>{unsupportedText}</span>
				</div>
			)}

			<SettingsGroup
				title="Notch tray"
				description="Show active agents near the MacBook notch. Hover the notch area to expand the tray, then click an agent to jump to its chat."
			>
				<SettingsRow
					title="Enable Notch Tray"
					description="Show running agents, pending approvals, questions, plans, completions, and failures near the notch."
					action={<Switch checked={enabled} onCheckedChange={setEnabled} />}
				/>
				<SettingsRow
					title="Keep tray expanded"
					description="Keep the agent list open instead of only expanding while the pointer is over the notch area."
					action={
						<Switch
							checked={pinned}
							disabled={!enabled}
							onCheckedChange={setPinned}
						/>
					}
				/>
			</SettingsGroup>

			<SettingsFrame
				title="What appears"
				description="The tray is intentionally quiet: it shows actionable agent states first, then recently completed turns for about 30 seconds."
			>
				<ul className="list-disc space-y-1 pl-4 text-[13px] leading-relaxed text-muted-foreground">
					<li>Permission requests, questions, and plan approvals</li>
					<li>Running agents as compact status circles</li>
					<li>Completed turns and failures from background chats</li>
				</ul>
			</SettingsFrame>
		</div>
	);
}

function CredInput({
	placeholder,
	value,
	onChange,
	type = "text",
}: {
	placeholder: string;
	value: string;
	onChange: (v: string) => void;
	type?: "text" | "password";
}) {
	return (
		<input
			type={type}
			value={value}
			placeholder={placeholder}
			spellCheck={false}
			autoComplete="off"
			onChange={(e) => onChange(e.target.value)}
			className="w-full rounded-lg border border-border/50 bg-background px-3 py-1.5 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-border"
		/>
	);
}

const BRANCH_STYLE_ORDER: ReadonlyArray<BranchNamingStyle> = [
	"username-slug",
	"slug",
	"feat-slug",
	"custom",
];

const BRANCH_STYLE_META: Record<
	BranchNamingStyle,
	{ label: string; example: string }
> = {
	"username-slug": {
		label: "username/branch",
		example: "swarajbachu/dark-mode",
	},
	slug: { label: "branch only", example: "dark-mode" },
	"feat-slug": { label: "feat/branch", example: "feat/dark-mode" },
	custom: { label: "custom prefix", example: "prefix/dark-mode" },
};

const APPEARANCE_OPTIONS: ReadonlyArray<{
	readonly value: AppearanceMode;
	readonly label: string;
}> = [
	{ value: "system", label: "System" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

function GeneralPane() {
	const appearanceMode = useSettingsStore((s) => s.appearanceMode);
	const setAppearanceMode = useSettingsStore((s) => s.setAppearanceMode);
	const defaultRuntimeMode = useSettingsStore((s) => s.defaultRuntimeMode);
	const setDefaultRuntimeMode = useSettingsStore(
		(s) => s.setDefaultRuntimeMode,
	);
	const completionSoundEnabled = useSettingsStore(
		(s) => s.completionSoundEnabled,
	);
	const setCompletionSoundEnabled = useSettingsStore(
		(s) => s.setCompletionSoundEnabled,
	);
	const completionSoundPreset = useSettingsStore(
		(s) => s.completionSoundPreset,
	);
	const setCompletionSoundPreset = useSettingsStore(
		(s) => s.setCompletionSoundPreset,
	);
	const branchNamingStyle = useSettingsStore((s) => s.branchNamingStyle);
	const setBranchNamingStyle = useSettingsStore((s) => s.setBranchNamingStyle);
	const branchNamingPrefix = useSettingsStore((s) => s.branchNamingPrefix);
	const setBranchNamingPrefix = useSettingsStore(
		(s) => s.setBranchNamingPrefix,
	);
	const setOnboardingCompleted = useSettingsStore(
		(s) => s.setOnboardingCompleted,
	);
	const setView = useUiStore((s) => s.setView);

	const {
		user,
		isSignedIn,
		signIn,
		signOut,
		signingIn,
		name,
		displayName,
		setDisplayName,
	} = useAuth();

	// Local mirror so typing is smooth; persist on blur to avoid an atomic
	// settings-file write per keystroke.
	const [prefixDraft, setPrefixDraft] = useState(branchNamingPrefix);
	useEffect(() => {
		setPrefixDraft(branchNamingPrefix);
	}, [branchNamingPrefix]);

	// Display-name override draft (local cosmetic alias; persisted to localStorage
	// via the auth store). Mirror on external change.
	const [nameDraft, setNameDraft] = useState(displayName);
	const [editingName, setEditingName] = useState(false);
	const nameInputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		setNameDraft(displayName);
		setEditingName(false);
	}, [displayName]);
	useEffect(() => {
		if (editingName) nameInputRef.current?.focus();
	}, [editingName]);

	const accountNameIsEmail = Boolean(user?.email && name === user.email);

	return (
		<div className="flex flex-col gap-4">
			<SettingsGroup
				title="Account"
				description="Sign in to sync your account across devices and (soon) drive remote agents from your phone."
			>
				{isSignedIn ? (
					<div className="flex items-center gap-3 px-4 py-3.5">
						<Avatar className="size-10">
							{user?.profilePictureUrl ? (
								<AvatarImage src={user.profilePictureUrl} alt={name} />
							) : null}
							<AvatarFallback>
								{(name || user?.email || "?").charAt(0).toUpperCase()}
							</AvatarFallback>
						</Avatar>
						<div className="flex min-w-0 flex-1 flex-col">
							{editingName ? (
								<input
									ref={nameInputRef}
									value={nameDraft}
									onChange={(e) => setNameDraft(e.target.value)}
									onBlur={() => {
										setDisplayName(nameDraft);
										setEditingName(false);
									}}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.currentTarget.blur();
										}
										if (e.key === "Escape") {
											setNameDraft(displayName);
											setEditingName(false);
										}
									}}
									placeholder="Your name"
									className="h-7 w-full max-w-[220px] rounded-md border border-border/50 bg-background px-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-border"
								/>
							) : (
								<div className="flex min-w-0 items-center gap-1.5">
									{accountNameIsEmail && user?.email ? (
										<BlurredEmail email={user.email} />
									) : (
										<span className="truncate text-sm font-medium text-foreground">
											{name}
										</span>
									)}
									<button
										type="button"
										onClick={() => {
											setNameDraft(displayName);
											setEditingName(true);
										}}
										aria-label="Edit display name"
										className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
									>
										<HugeiconsIcon
											icon={PencilEdit01Icon}
											className="size-3.5"
										/>
									</button>
								</div>
							)}
							{!accountNameIsEmail && user?.email ? (
								<BlurredEmail email={user.email} />
							) : null}
						</div>
						<Button variant="settings" size="sm" onClick={() => void signOut()}>
							Sign out
						</Button>
					</div>
				) : (
					<SettingsRow
						title="Not signed in"
						description="You're using Zuse Alpha locally without an account. Sign in to sync and unlock remote agents."
						action={
							<Button
								variant="settings"
								size="sm"
								loading={signingIn}
								onClick={() => void signIn()}
							>
								Sign in
							</Button>
						}
					/>
				)}
			</SettingsGroup>

			<SettingsGroup
				title="Appearance"
				description="Choose the app theme, or follow your system setting."
			>
				<SettingsRow
					title="Theme"
					description="Choose the app theme, or follow your system setting."
					action={
						<div className="inline-flex rounded-lg border border-border/60 bg-muted p-0.5">
							{APPEARANCE_OPTIONS.map((option) => {
								const active = option.value === appearanceMode;
								return (
									<button
										key={option.value}
										type="button"
										aria-pressed={active}
										onClick={() => setAppearanceMode(option.value)}
										className={cn(
											"h-7 rounded-md px-2.5 text-xs font-medium transition-colors",
											active
												? "bg-background text-foreground"
												: "text-muted-foreground hover:text-foreground",
										)}
									>
										{option.label}
									</button>
								);
							})}
						</div>
					}
				/>
			</SettingsGroup>

			<SettingsGroup
				title="Agent defaults"
				description="Defaults used when a new chat or background agent starts."
			>
				<SettingsRow
					title="Default permission mode"
					description="How the agent handles tool calls in new sessions. Each session can override this from its composer."
					action={
						<Select
							value={defaultRuntimeMode}
							onValueChange={(v) => setDefaultRuntimeMode(v as RuntimeMode)}
							items={MODES_ORDER.map((m) => ({
								label: MODE_META[m].label,
								value: m,
							}))}
						>
							<SelectTrigger size="sm" className="w-[180px]">
								<SelectValue />
							</SelectTrigger>
							<SelectPopup>
								{MODES_ORDER.map((mode) => {
									const m = MODE_META[mode];
									return (
										<SelectItem key={mode} value={mode}>
											<div className="flex flex-col">
												<span>{m.label}</span>
												<span className="text-[10px] text-muted-foreground">
													{m.description}
												</span>
											</div>
										</SelectItem>
									);
								})}
							</SelectPopup>
						</Select>
					}
				/>

				<SettingsRow
					title="Agent completion sound"
					description="Play a short sound when any agent turn finishes, including agents working in background chats."
					action={
						<Switch
							checked={completionSoundEnabled}
							onCheckedChange={(value) => {
								setCompletionSoundEnabled(value);
								if (value) void prepareCompletionSound();
							}}
						/>
					}
				>
					<div
						className={cn(
							"flex flex-wrap items-center gap-2",
							!completionSoundEnabled && "opacity-60",
						)}
					>
						<HugeiconsIcon
							icon={VolumeHighIcon}
							className="size-4 shrink-0 text-muted-foreground"
						/>
						<Select
							value={completionSoundPreset}
							onValueChange={(v) =>
								setCompletionSoundPreset(v as CompletionSoundPreset)
							}
							items={COMPLETION_SOUND_PRESETS.map((preset) => ({
								label: preset.label,
								value: preset.value,
							}))}
						>
							<SelectTrigger
								size="sm"
								className="w-[160px]"
								disabled={!completionSoundEnabled}
							>
								<SelectValue />
							</SelectTrigger>
							<SelectPopup>
								{COMPLETION_SOUND_PRESETS.map((preset) => (
									<SelectItem key={preset.value} value={preset.value}>
										{preset.label}
									</SelectItem>
								))}
							</SelectPopup>
						</Select>
						<Button
							variant="settings"
							size="sm"
							disabled={!completionSoundEnabled}
							onClick={() => void playCompletionSound(completionSoundPreset)}
						>
							Preview
						</Button>
					</div>
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup
				title="Workspace naming"
				description="Controls how Zuse Alpha names new worktree-backed branches."
			>
				<SettingsRow
					title="Branch naming"
					description="After the first successful agent turn, unnamed chats and sessions receive a title. Fresh unpublished worktree branches receive a separate semantic name in this shape."
					action={
						<Select
							value={branchNamingStyle}
							onValueChange={(v) =>
								setBranchNamingStyle(v as BranchNamingStyle)
							}
							items={BRANCH_STYLE_ORDER.map((s) => ({
								label: BRANCH_STYLE_META[s].label,
								value: s,
							}))}
						>
							<SelectTrigger size="sm" className="w-[180px]">
								<SelectValue />
							</SelectTrigger>
							<SelectPopup>
								{BRANCH_STYLE_ORDER.map((style) => {
									const m = BRANCH_STYLE_META[style];
									return (
										<SelectItem key={style} value={style}>
											<div className="flex flex-col">
												<span>{m.label}</span>
												<span className="text-[10px] text-muted-foreground">
													{m.example}
												</span>
											</div>
										</SelectItem>
									);
								})}
							</SelectPopup>
						</Select>
					}
				>
					{branchNamingStyle === "custom" && (
						<div className="flex flex-col gap-1.5 rounded-lg border border-border/40 bg-background/60 p-3">
							<label
								htmlFor="branch-naming-prefix"
								className="text-xs font-medium text-muted-foreground"
							>
								Custom prefix
							</label>
							<input
								id="branch-naming-prefix"
								type="text"
								value={prefixDraft}
								placeholder="e.g. swaraj or team/wip"
								spellCheck={false}
								onChange={(e) => setPrefixDraft(e.target.value)}
								onBlur={() => {
									if (prefixDraft !== branchNamingPrefix) {
										setBranchNamingPrefix(prefixDraft);
									}
								}}
								className="h-8 w-full max-w-[260px] rounded-lg border border-border/50 bg-background px-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-border"
							/>
							<p className="text-xs leading-snug text-muted-foreground">
								Slash-joined before the slug. Letters, digits, slashes and
								dashes; leave empty for a bare slug.
							</p>
						</div>
					)}
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup title="Setup">
				<SettingsRow
					title="Onboarding"
					description="Replay the first-launch welcome flow. Your existing projects and credentials stay put."
					action={
						<Button
							variant="settings"
							size="sm"
							onClick={() => {
								setView("chat");
								setOnboardingCompleted(false);
							}}
						>
							Show again
						</Button>
					}
				/>
			</SettingsGroup>
			<WorkspacePane />
			<NotchSettingsPane />
		</div>
	);
}

/**
 * Rarely-needed diagnostic settings kept out of the primary rail flow.
 */
function AdvancedPane() {
	return (
		<div className="flex flex-col gap-4">
			<DiagnosticsPane />
		</div>
	);
}

function ProvidersPane() {
	const availability = useProvidersStore((s) => s.availability);
	const loading = useProvidersStore((s) => s.loading);
	const availabilityLoaded = useProvidersStore((s) => s.availabilityLoaded);
	const error = useProvidersStore((s) => s.error);
	const load = useProvidersStore((s) => s.load);
	const refresh = useProvidersStore((s) => s.refresh);
	const defaultProviderId = useSettingsStore((s) => s.defaultProviderId);
	const setDefaultProvider = useSettingsStore((s) => s.setDefaultProvider);
	const providerEnabled = useSettingsStore((s) => s.providerEnabled);

	// Refresh once when the pane opens. We deliberately do NOT re-poll on every
	// window focus: `refresh()` → `agent.availability` reads the OS keychain
	// (`credentials.listConfigured`), and on unsigned/dev builds macOS re-prompts
	// for the "zuse" keychain on each access — so a focus-triggered refresh meant
	// a keychain prompt every time the window regained focus. The manual refresh
	// button covers the occasional "re-check now" case.
	useEffect(() => {
		void load();
	}, [load]);

	const now = useRelativeTimeTick(15_000);
	const lastCheckedAt = useMemo(() => {
		let latest: Date | null = null;
		for (const a of availability) {
			const ts = a.lastCheckedAt;
			if (ts === undefined) continue;
			if (latest === null || ts.getTime() > latest.getTime()) latest = ts;
		}
		return latest;
	}, [availability]);

	const providers: ReadonlyArray<ProviderId> = [
		"claude",
		"codex",
		"grok",
		"gemini",
		"cursor",
		"opencode",
	];
	const [selectedProvider, setSelectedProvider] =
		useState<ProviderId>("claude");
	const availabilityById = useMemo(() => {
		const map = new Map<ProviderId, (typeof availability)[number]>();
		for (const a of availability) map.set(a.providerId, a);
		return map;
	}, [availability]);

	const statusLabel = loading
		? "Checking…"
		: error !== null
			? `Probe failed · ${error}`
			: lastCheckedAt
				? `Checked ${formatRelativeTime(lastCheckedAt, now) ?? "just now"}`
				: availability.length > 0
					? "Checked"
					: "Not checked yet";

	return (
		<>
			<Frame>
				<FrameHeader className="flex flex-row items-center justify-between px-2 py-2 w-full">
					<p className="text-sm font-semibold text-foreground">
						Installed providers
					</p>
					<div className="flex items-center gap-2">
						<span className="text-[11px] text-muted-foreground/80">
							{statusLabel}
						</span>
						<Button
							variant="ghost"
							size="icon-xs"
							onClick={() => void refresh()}
							disabled={loading}
							aria-label="Refresh provider status"
						>
							<RefreshIcon
								className={cn("size-3.5", loading && "animate-spin")}
								aria-hidden
							/>
						</Button>
					</div>
				</FrameHeader>
				<div className="flex flex-col gap-2 px-2 pb-2">
					<div
						role="tablist"
						aria-label="Provider settings"
						className="flex min-w-0 gap-1 overflow-x-auto border-b border-border/50"
					>
						{providers.map((pid) => {
							const selected = selectedProvider === pid;
							return (
								<button
									key={pid}
									type="button"
									role="tab"
									aria-selected={selected}
									onClick={() => setSelectedProvider(pid)}
									className={cn(
										"flex min-h-9 shrink-0 items-center gap-2 border-b px-2.5 text-sm transition-colors",
										selected
											? "border-primary text-foreground"
											: "border-transparent text-muted-foreground hover:text-foreground",
									)}
								>
									<ProviderIcon providerId={pid} className="size-3.5" />
									<span>{PROVIDER_LABEL[pid]}</span>
									{pid === "opencode" && (
										<span className="rounded border border-border/60 bg-muted/70 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
											New
										</span>
									)}
								</button>
							);
						})}
					</div>
					<Card>
						<ProviderCard
							providerId={selectedProvider}
							availability={availabilityById.get(selectedProvider)}
							loading={isInitialProviderAvailabilityLoading(
								loading,
								availabilityLoaded,
							)}
						/>
					</Card>
				</div>
				<FrameFooter className="px-2 py-1 w-full">
					<p className="text-xs leading-relaxed text-muted-foreground">
						Zuse Alpha uses your existing CLI credentials — Claude Code, Codex,
						Grok, Gemini, Cursor, and OpenCode all sign in through their own
						login flows.
					</p>
				</FrameFooter>
			</Frame>

			<SettingsFrame
				title="Default agent"
				description="Which provider new chats start in. Change per session from the composer."
				flush
			>
				<div
					role="radiogroup"
					aria-label="Default agent"
					className="flex flex-col divide-y divide-border/40"
				>
					{providers
						.filter((pid) => {
							// Hide providers the user has toggled off. Cursor is still
							// excluded because it has an unconditional subscription gate.
							// Grok is allowed once the probe confirms a usable paid tier,
							// including X Premium+.
							if (providerEnabled[pid] === false) return false;
							if (pid === "cursor") return false;
							return true;
						})
						.map((pid) => {
							const selected = pid === defaultProviderId;
							return (
								// biome-ignore lint/a11y/useSemanticElements: custom radio remains a native focusable button.
								<button
									key={pid}
									type="button"
									role="radio"
									aria-checked={selected}
									onClick={() => setDefaultProvider(pid)}
									className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
								>
									<ProviderIcon providerId={pid} className="size-4 shrink-0" />
									<span className="flex-1 truncate text-sm font-medium text-foreground">
										{PROVIDER_LABEL[pid]}
									</span>
									<RadioCheck active={selected} />
								</button>
							);
						})}
				</div>
			</SettingsFrame>
		</>
	);
}

function WorkspacePane() {
	const defaultAutoCreateWorktree = useSettingsStore(
		(s) => s.defaultAutoCreateWorktree,
	);
	const setDefaultAutoCreateWorktree = useSettingsStore(
		(s) => s.setDefaultAutoCreateWorktree,
	);
	return (
		<SettingsFrame
			title="Auto-create worktree for new chats"
			trailing={
				<Switch
					checked={defaultAutoCreateWorktree}
					onCheckedChange={setDefaultAutoCreateWorktree}
				/>
			}
			description="When on, each new chat runs in its own git worktree under ~/.zuse/<repo>/<name>/, branched off the project's HEAD. Per-repo settings can override this default."
		/>
	);
}

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

/**
 * Frame-shaped settings block: outer muted shell with `FrameHeader` (title
 * + optional trailing action), optional inner `Card` body, and
 * `FrameFooter` for the description. Use for every settings group that
 * fits the "title • body • description" shape — sub-agents-style.
 */
export function SettingsFrame({
	title,
	trailing,
	description,
	bodyClassName,
	flush,
	children,
}: {
	title: string;
	trailing?: React.ReactNode;
	description?: React.ReactNode;
	bodyClassName?: string;
	/** When true, render children flush inside the Card without inner padding. */
	flush?: boolean;
	children?: React.ReactNode;
}) {
	return (
		<Frame>
			<FrameHeader className="flex w-full flex-row items-center justify-between px-2 py-1.5">
				<div className="flex min-w-0 items-center gap-1.5">
					<p className="truncate text-[13px] font-medium text-foreground">
						{title}
					</p>
					{description && <InfoTip content={description} />}
				</div>
				{trailing}
			</FrameHeader>
			{children && (
				<Card className={bodyClassName}>
					{flush ? children : <div className="px-4 py-3">{children}</div>}
				</Card>
			)}
		</Frame>
	);
}

/**
 * Grouped settings section: muted outer frame, compact header, one inner
 * card split into rows. Use when several related settings should read as a
 * single decision area instead of separate cards.
 */
export function SettingsGroup({
	title,
	description,
	trailing,
	children,
}: {
	title: string;
	description?: React.ReactNode;
	trailing?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<Frame>
			<FrameHeader className="flex w-full flex-row items-center justify-between gap-3 px-2 py-1.5">
				<div className="flex min-w-0 items-center gap-1.5">
					<p className="truncate text-[13px] font-medium text-foreground">
						{title}
					</p>
					{description && <InfoTip content={description} />}
				</div>
				{trailing && <div className="shrink-0">{trailing}</div>}
			</FrameHeader>
			<Card className="overflow-hidden">
				<div className="flex flex-col divide-y divide-border/40">
					{children}
				</div>
			</Card>
		</Frame>
	);
}

/**
 * Single-surface container for a group of settings rows. Renders one
 * rounded panel with a subtle muted background — no inner card, no double
 * nesting. Pair with `SettingsRow` for the row layout.
 */
export function SettingsCard({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div
			className={cn(
				"flex flex-col divide-y divide-border/40 overflow-hidden rounded-lg border border-border/60 bg-muted/30",
				className,
			)}
		>
			{children}
		</div>
	);
}

/**
 * Compact uppercase header bar for a `SettingsCard`. Single line, optional
 * leading icon, optional trailing slot (status text, refresh button,
 * toggle). Renders above the rest of the card content with a bottom
 * divider courtesy of the parent's `divide-y`.
 */
export function SettingsCardHeader({
	icon: Icon,
	title,
	trailing,
}: {
	icon?: IconSvgElement;
	title: string;
	trailing?: React.ReactNode;
}) {
	return (
		<header className="flex h-10 shrink-0 items-center gap-2 px-4 text-muted-foreground">
			{Icon && <HugeiconsIcon icon={Icon} className="size-3.5" aria-hidden />}
			<span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
				{title}
			</span>
			{trailing && (
				<div className="flex shrink-0 items-center gap-2">{trailing}</div>
			)}
		</header>
	);
}

/**
 * Settings row: title + (optional) description on the left, action on the
 * right. When `children` are passed instead of `action`, they render under
 * the title/description (for cases like radio-group pickers).
 */
export function SettingsRow({
	icon: Icon,
	title,
	description,
	action,
	className,
	children,
}: {
	icon?: IconSvgElement;
	title: string;
	description?: string;
	action?: React.ReactNode;
	className?: string;
	children?: React.ReactNode;
}) {
	return (
		<div className={cn("flex flex-col gap-3 px-4 py-3", className)}>
			<div className="flex items-start gap-3">
				{Icon && (
					<HugeiconsIcon
						icon={Icon}
						className="size-4 shrink-0 text-muted-foreground"
						aria-hidden
					/>
				)}
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="text-sm font-medium text-foreground">{title}</div>
					{description && (
						<div className="text-[11px] leading-snug text-muted-foreground">
							{description}
						</div>
					)}
				</div>
				{action && <div className="shrink-0 pt-0.5">{action}</div>}
			</div>
			{children}
		</div>
	);
}

/**
 * Legacy `Section` helper kept for back-compat with call-sites that
 * haven't been migrated to `SettingsCard` + `SettingsRow`. New code should
 * prefer those primitives.
 */
export function Section({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: React.ReactNode;
}) {
	return (
		<SettingsCard>
			<SettingsRow title={title} description={description}>
				{children}
			</SettingsRow>
		</SettingsCard>
	);
}

export function OptionGroup({
	children,
	columns,
}: {
	children: React.ReactNode;
	columns?: 2 | 3;
}) {
	return (
		<div
			role="radiogroup"
			className={cn(
				"gap-2",
				columns === 2 && "grid grid-cols-2",
				columns === 3 && "grid grid-cols-3",
				!columns && "flex flex-col",
			)}
		>
			{children}
		</div>
	);
}

export function OptionCard({
	icon: Icon,
	iconNode,
	title,
	description,
	active,
	onClick,
	disabled,
}: {
	icon?: IconSvgElement;
	iconNode?: React.ReactNode;
	title: string;
	description?: string;
	active: boolean;
	onClick: () => void;
	disabled?: boolean;
}) {
	const compact = !description;
	return (
		// biome-ignore lint/a11y/useSemanticElements: custom radio remains a native focusable button.
		<button
			type="button"
			role="radio"
			aria-checked={active}
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"group flex w-full items-center gap-3 rounded-lg border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
				compact ? "px-3 py-2" : "items-start px-3.5 py-3",
				active
					? "border-foreground/30 bg-accent/40"
					: "border-border/50 hover:bg-muted/40",
			)}
		>
			<RadioDot active={active} className={compact ? "" : "mt-0.5"} />
			{(Icon || iconNode) && (
				<span
					className={cn(
						"flex size-4 shrink-0 items-center justify-center text-muted-foreground group-aria-checked:text-foreground",
						!compact && "mt-0.5",
					)}
				>
					{iconNode ??
						(Icon ? <HugeiconsIcon icon={Icon} className="size-4" /> : null)}
				</span>
			)}
			<span className="flex min-w-0 flex-1 flex-col gap-1">
				<span className="text-sm font-medium leading-none text-foreground">
					{title}
				</span>
				{description && (
					<span className="text-xs leading-snug text-muted-foreground">
						{description}
					</span>
				)}
			</span>
		</button>
	);
}

function RadioDot({
	active,
	className,
}: {
	active: boolean;
	className?: string;
}) {
	return (
		<span
			aria-hidden
			className={cn(
				"flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
				active
					? "border-foreground bg-background"
					: "border-border bg-background group-hover:border-foreground/60",
				className,
			)}
		>
			<span
				className={cn(
					"size-1.5 rounded-full bg-foreground transition-transform duration-150",
					active ? "scale-100" : "scale-0",
				)}
			/>
		</span>
	);
}

/**
 * Cleaner radio rendering: filled solid disc with checkmark when selected,
 * hollow bordered circle when not. No inner-dot pattern.
 */
export function RadioCheck({
	active,
	className,
}: {
	active: boolean;
	className?: string;
}) {
	return (
		<span
			aria-hidden
			className={cn(
				"flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
				active
					? "border-primary bg-primary"
					: "border-border bg-background group-hover:border-foreground/60",
				className,
			)}
		>
			{active && (
				<HugeiconsIcon
					icon={Tick01Icon}
					className="size-2.5 text-primary-foreground"
					strokeWidth={3.5}
					aria-hidden
				/>
			)}
		</span>
	);
}

export function CheckboxField({
	checked,
	onChange,
	label,
	description,
	disabled,
}: {
	checked: boolean;
	onChange: (v: boolean) => void;
	label: string;
	description?: string;
	disabled?: boolean;
}) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: CheckboxInput renders a native checkbox.
		<label
			className={cn(
				"group/checkbox flex items-start gap-3 rounded-lg border border-border/50 px-3.5 py-3 text-sm transition-colors hover:bg-muted/40 has-[:focus-visible]:border-foreground/30 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
				disabled && "pointer-events-none opacity-50",
			)}
		>
			<CheckboxInput
				checked={checked}
				disabled={disabled}
				onChange={onChange}
				className="mt-0.5"
			/>
			<span className="flex flex-1 flex-col gap-0.5">
				<span className="font-medium leading-none text-foreground">
					{label}
				</span>
				{description && (
					<span className="text-xs leading-snug text-muted-foreground">
						{description}
					</span>
				)}
			</span>
		</label>
	);
}

/**
 * Visually-styled checkbox: native `<input>` is `sr-only` for accessibility
 * and form semantics, custom box is rendered as a sibling so we get
 * `peer-focus-visible` rings + a real checkmark on solid-foreground fill.
 */
export function CheckboxInput({
	checked,
	onChange,
	disabled,
	className,
}: {
	checked: boolean;
	onChange: (v: boolean) => void;
	disabled?: boolean;
	className?: string;
}) {
	return (
		<span className={cn("relative inline-flex shrink-0", className)}>
			<input
				type="checkbox"
				checked={checked}
				disabled={disabled}
				onChange={(e) => onChange(e.target.checked)}
				className="peer absolute inset-0 size-4 cursor-pointer opacity-0 disabled:cursor-not-allowed"
			/>
			<span
				aria-hidden
				className={cn(
					"flex size-4 items-center justify-center rounded-[5px] border transition-colors",
					"peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-background",
					checked
						? "border-foreground bg-foreground"
						: "border-border bg-background peer-hover:border-foreground/60",
					disabled && "opacity-50",
				)}
			>
				{checked && (
					<HugeiconsIcon
						icon={Tick01Icon}
						className="size-3 text-background"
						strokeWidth={3.5}
						aria-hidden
					/>
				)}
			</span>
		</span>
	);
}

/**
 * "Inherits global ↔ Custom" segmented control for per-repo overrides.
 * When inheriting, the children dim and clicks bypass. Picking any option
 * inside `children` flips back to "Custom".
 */
export function OverrideField({
	isOverridden,
	globalLabel,
	onClear,
	children,
}: {
	isOverridden: boolean;
	globalLabel: string;
	onClear: () => void;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-2.5">
			<div className="flex items-center gap-2">
				<div className="inline-flex rounded-md border border-border/50 bg-muted p-0.5 text-xs">
					<button
						type="button"
						onClick={onClear}
						className={cn(
							"rounded px-2.5 py-1 transition-colors",
							!isOverridden
								? "bg-background text-foreground"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						Inherit
					</button>
					<button
						type="button"
						disabled={isOverridden}
						className={cn(
							"rounded px-2.5 py-1 transition-colors",
							isOverridden
								? "bg-background text-foreground"
								: "text-muted-foreground",
						)}
					>
						Custom
					</button>
				</div>
				{!isOverridden && (
					<span className="truncate text-xs text-muted-foreground">
						{globalLabel}
					</span>
				)}
			</div>
			<div
				className={cn(
					"transition-opacity",
					isOverridden ? "" : "pointer-events-none opacity-50",
				)}
			>
				{children}
			</div>
		</div>
	);
}

export function ModelSelect({
	providerId,
	value,
	onChange,
}: {
	providerId: ProviderId;
	value: string | null;
	onChange: (model: string) => void;
}) {
	const modelEnabledByProvider = useSettingsStore(
		(s) => s.modelEnabledByProvider,
	);
	const models = visibleModelsForProvider(providerId, modelEnabledByProvider, {
		includeModelId: value,
	});
	const normalizedValue =
		value !== null &&
		(models.some((m) => m.id === value) || models.length === 0)
			? (value ?? "")
			: (models[0]?.id ?? "");
	const items = useMemo(
		() => models.map((m) => ({ value: m.id, label: m.label })),
		[models],
	);
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-xs font-medium text-muted-foreground">
				Default model
			</span>
			<Select
				value={normalizedValue}
				onValueChange={(next) => onChange(next as string)}
				items={items}
			>
				<SelectTrigger size="sm">
					<SelectValue />
				</SelectTrigger>
				<SelectPopup>
					{models.map((m) => (
						<SelectItem key={m.id} value={m.id}>
							{m.label}
						</SelectItem>
					))}
				</SelectPopup>
			</Select>
		</div>
	);
}

// Re-exported helpers consumed by `ChatComposer`'s "ensure valid defaults"
// path that picks an effective provider/model when the user's saved
// default isn't currently logged in.
export function ensureValidDefaultsForRuntime(
	ready: ReadonlyArray<ProviderId>,
): { providerId: ProviderId; model: string; runtimeMode: RuntimeMode } | null {
	const settings = useSettingsStore.getState();
	if (ready.length === 0) return null;
	const provider = ready.includes(settings.defaultProviderId)
		? settings.defaultProviderId
		: ready[0]!;
	const model =
		settings.defaultModelByProvider[provider] ??
		visibleModelsForProvider(provider, settings.modelEnabledByProvider)[0]
			?.id ??
		MODELS_BY_PROVIDER[provider][0]!.id;
	return {
		providerId: provider,
		model,
		runtimeMode: settings.defaultRuntimeMode,
	};
}

export { PROVIDER_LABEL } from "../lib/provider-labels.ts";
export type { FolderId };
