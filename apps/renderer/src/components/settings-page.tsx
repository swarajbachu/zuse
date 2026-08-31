import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	type AppearanceMode,
	type BranchNamingStyle,
	CommandId,
	type CompletionSoundPreset,
	type ComputerAwakeMode,
	type ComputerAwakeStatus,
	EnvironmentId,
	type Folder,
	type FolderId,
	type ProviderId,
	type RuntimeMode,
	visibleModelsForProvider,
} from "@zuse/contracts";
import {
	Alert01Icon,
	BrowserIcon,
	ConnectIcon,
	Delete02Icon,
	DocumentAttachmentIcon,
	Folder01Icon,
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
} from "@zuse/icons/solid-rounded";
import { ChevronLeft, Plus, RefreshCw as RefreshIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cloudWorkspaceBetaAvailable } from "~/lib/cloud-machines-availability.ts";
import { displayPath } from "~/lib/display-path";
import { hasHostCapability, isMacHost } from "~/lib/host-platform";
import { rendererPlatformCapabilities } from "~/lib/platform-capabilities.ts";
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
import {
	computerAwakeModeDescription,
	computerAwakeStatusText,
} from "../lib/computer-awake.ts";
import { dispatchEnvironmentShellCommand } from "../lib/environment-shell-client-bus.ts";
import { PROVIDER_LABEL } from "../lib/provider-labels.ts";
import { useSettingsStore } from "../lib/settings-client-bus.ts";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { useProvidersStore } from "../store/providers.ts";
import { type SettingsSection, useUiStore } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { BlurredEmail } from "./blurred-email.tsx";
import { BrowserProfileSelect } from "./browser-profile-select.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { ProviderCard } from "./provider-card.tsx";
import { ProviderIcon } from "./provider-icons.tsx";
import { MODE_META, MODES_ORDER } from "./runtime-mode-meta.ts";
import { CloudWorkspacePool } from "./settings/cloud-workspace-pool.tsx";
import { DeveloperPane } from "./settings/developer-pane.tsx";
import { DevicesPane } from "./settings/devices-pane.tsx";
import { DiagnosticsPane as FullDiagnosticsPane } from "./settings/diagnostics-pane.tsx";
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
import { SegmentedTabs } from "./ui/segmented-tabs.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsRow,
	SettingsFrame as SharedSettingsFrame,
} from "./ui/settings-panel.tsx";

export { SettingsGroup, SettingsRow } from "./ui/settings-panel.tsx";

import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "./ui/select.tsx";
import { Switch } from "./ui/switch";

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
		id: "defaults",
		label: "Default models",
		Icon: TaskDone01Icon,
		section: { kind: "defaults" },
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
		label: "Remote access",
		Icon: SmartPhone01Icon,
		section: { kind: "devices" },
	},
	{
		id: "machines",
		label: "Cloud workspaces · Beta",
		Icon: ConnectIcon,
		section: { kind: "machines" },
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
		id: "diagnostics",
		label: "Diagnostics",
		Icon: DocumentAttachmentIcon,
		section: { kind: "diagnostics" },
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

const CLOUD_MACHINES_AVAILABLE = cloudWorkspaceBetaAvailable();

const VISIBLE_RAIL: ReadonlyArray<RailItemBase> = TOP_RAIL.filter(
	(item) =>
		(item.id !== "developer" || import.meta.env.DEV) &&
		(item.id !== "machines" || CLOUD_MACHINES_AVAILABLE),
);

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
	const desktop = rendererPlatformCapabilities().desktop;
	const visibleSection: SettingsSection =
		!CLOUD_MACHINES_AVAILABLE && section.kind === "machines"
			? { kind: "general" }
			: section;

	useEffect(() => {
		if (folders.length === 0) void loadFolders();
	}, [folders.length, loadFolders]);

	useEffect(() => {
		if (!CLOUD_MACHINES_AVAILABLE && section.kind === "machines") {
			setSection({ kind: "general" });
		}
	}, [section.kind, setSection]);

	return (
		<div className="settings-surface flex min-h-0 flex-1 flex-col bg-background [&_button[data-slot=button]:not([class*='size-'])]:h-7 [&_button[data-slot=button]:not([class*='size-'])]:text-[11px]">
			<header className="flex h-9 shrink-0 items-center border-b border-border bg-background/90 px-3 text-xs text-muted-foreground backdrop-blur-md [-webkit-app-region:drag]">
				<div className="w-16 shrink-0" />
				<button
					type="button"
					onClick={() => setView("chat")}
					aria-label="Back to app"
					className="flex items-center gap-1 rounded p-1 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground [-webkit-app-region:no-drag]"
				>
					<ChevronLeft className="size-3.5" />
					<span>Back to app</span>
				</button>
			</header>
			<div className="flex min-h-0 flex-1">
				<Rail
					section={visibleSection}
					onSelect={setSection}
					folders={folders}
					desktop={desktop}
				/>
				<div className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-smooth overscroll-contain px-6 py-6 max-[800px]:px-4 max-[800px]:py-4">
					<div
						className={cn(
							"mx-auto flex w-full flex-col gap-5",
							visibleSection.kind === "diagnostics" ||
								visibleSection.kind === "shortcuts"
								? "max-w-6xl"
								: visibleSection.kind === "pokedex"
									? "max-w-5xl"
									: "max-w-3xl",
						)}
					>
						<SectionTitle section={visibleSection} folders={folders} />
						<Pane section={visibleSection} />
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
	desktop,
}: {
	section: SettingsSection;
	onSelect: (section: SettingsSection) => void;
	folders: ReadonlyArray<Folder>;
	desktop: boolean;
}) {
	return (
		<nav className="flex w-52 shrink-0 flex-col gap-4 border-r border-sidebar-border bg-sidebar px-2.5 py-3 text-xs text-sidebar-foreground max-[800px]:w-12 max-[800px]:px-1.5">
			<div className="flex flex-col gap-0.5">
				{VISIBLE_RAIL.filter(
					(item) => desktop || item.section.kind !== "machines",
				).map((item) => {
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
				<div className="flex flex-col gap-2 max-[800px]:hidden">
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
				"flex min-h-7 items-center gap-2 rounded-md px-2.5 py-1 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-[800px]:justify-center max-[800px]:px-1.5",
				active
					? "bg-sidebar-accent text-sidebar-accent-foreground"
					: "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
			)}
		>
			<HugeiconsIcon icon={Icon} className="size-4 shrink-0" />
			<span className={cn("max-[800px]:sr-only", truncate && "truncate")}>
				{label}
			</span>
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
		if (section.kind === "defaults") {
			return {
				title: "Default models",
				subtitle: "Choose how new chats start.",
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
				title: "Remote access",
				subtitle:
					"Use this computer from your phone, a browser, or another computer.",
			};
		}
		if (section.kind === "machines") {
			return {
				title: "Cloud workspaces · Beta",
				subtitle:
					"Connect GitHub and your coding agents, then keep work running when this app is closed.",
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
		if (section.kind === "diagnostics") {
			return {
				title: "Diagnostics",
				subtitle:
					"Inspect failures, traces, processes, resources, and local support bundles.",
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
		<div className="flex min-w-0 flex-col gap-1 border-b border-border pb-4">
			<h1 className="truncate text-xl font-medium tracking-[-0.01em] text-foreground">
				{title}
			</h1>
			{subtitle && (
				<p className="max-w-2xl text-xs leading-5 text-muted-foreground">
					{subtitle}
				</p>
			)}
		</div>
	);
}

function Pane({ section }: { section: SettingsSection }) {
	if (section.kind === "general") return <GeneralPane />;
	if (section.kind === "defaults") return <DefaultModelsPane />;
	if (section.kind === "providers") return <ProvidersPane />;
	if (section.kind === "integrations") return <LinearIntegrationsPane />;
	if (section.kind === "mcp") return <McpServersPane />;
	if (section.kind === "devices") return <DevicesPane />;
	if (section.kind === "machines") {
		return (
			<section className="flex min-h-0 flex-1 flex-col gap-4 text-xs">
				<CloudWorkspacePool />
			</section>
		);
	}
	if (section.kind === "browser") return <BrowserSettingsPagePane />;
	if (section.kind === "pokedex") return <PokedexPane />;
	if (section.kind === "diagnostics") return <FullDiagnosticsPane />;
	if (section.kind === "shortcuts") return <KeybindingsPane />;
	if (section.kind === "developer") return <DeveloperPane />;
	return <RepositorySettings projectId={section.projectId} />;
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
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [clearOpen, setClearOpen] = useState(false);

	useEffect(() => {
		let cancelled = false;
		const browser = window.zuse?.browser;
		void browser?.getCookieImportStatus?.().then((nextStatus) => {
			if (cancelled) return;
			if (nextStatus !== undefined) setStatus(nextStatus);
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
				title="Privacy"
				description="Built-in browser data stays in an isolated in-memory partition. Explicitly imported cookies are encrypted with the app vault and restored on restart."
			>
				<SettingsRow
					title="Browsing data"
					description="Remove cookies, site storage, and cache from the current built-in browser session without changing other browsers."
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
 * via `browser_login`. Passwords go into the encrypted local vault (write-only
 * from here; the list RPC never returns them). The warning banner is
 * load-bearing: real credentials must never live here.
 */
function BrowserTestLoginsPane() {
	const environmentId = useEnvironmentCatalogStore((state) =>
		EnvironmentId.make(state.activeEnvironmentId),
	);
	const [creds, setCreds] = useState<ReadonlyArray<BrowserCredRow>>([]);
	const [origin, setOrigin] = useState("");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);

	const load = async () => {
		const { result: list } = await dispatchEnvironmentShellCommand<
			Record<string, never>,
			ReadonlyArray<BrowserCredRow>
		>({
			environmentId,
			kind: "browser.listCredentials",
			commandId: CommandId.make(`browser-credentials:${crypto.randomUUID()}`),
			payload: {},
		});
		setCreds(list.map((c) => ({ origin: c.origin, username: c.username })));
	};

	useEffect(() => {
		void load();
	}, []);

	const add = async () => {
		if (origin.trim() === "" || password === "") return;
		setBusy(true);
		try {
			await dispatchEnvironmentShellCommand<
				{
					readonly origin: string;
					readonly username: string;
					readonly password: string;
				},
				unknown
			>({
				environmentId,
				kind: "browser.setCredential",
				commandId: CommandId.make(
					`browser-credential-set:${crypto.randomUUID()}`,
				),
				payload: {
					origin: origin.trim(),
					username: username.trim(),
					password,
				},
			});
			setOrigin("");
			setUsername("");
			setPassword("");
			await load();
		} finally {
			setBusy(false);
		}
	};

	const remove = async (target: string) => {
		await dispatchEnvironmentShellCommand<{ readonly origin: string }, unknown>(
			{
				environmentId,
				kind: "browser.removeCredential",
				commandId: CommandId.make(
					`browser-credential-remove:${crypto.randomUUID()}`,
				),
				payload: { origin: target },
			},
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
	const hostSupportsNotch = hasHostCapability("notchTray");
	const [support, setSupport] = useState<{
		supported: boolean;
		reason: "supported" | "not-macos" | "no-notched-display";
	} | null>(null);

	useEffect(() => {
		if (!hostSupportsNotch) return;
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
	}, [hostSupportsNotch]);

	if (!hostSupportsNotch) return null;
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

const COMPUTER_AWAKE_OPTIONS: ReadonlyArray<{
	readonly value: ComputerAwakeMode;
	readonly label: string;
}> = [
	{ value: "off", label: "Off" },
	{ value: "auto", label: "Auto" },
	{ value: "always", label: "Always" },
];

function ComputerAwakeSettings() {
	const [status, setStatus] = useState<ComputerAwakeStatus | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const awake = window.zuse?.computerAwake;
		if (awake === undefined) return;
		let mounted = true;
		const unsubscribe = awake.onChanged((next) => {
			if (mounted) setStatus(next);
		});
		void awake
			.getStatus()
			.then((next) => {
				if (mounted) setStatus(next);
			})
			.catch((cause) => {
				if (mounted)
					setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			mounted = false;
			unsubscribe();
		};
	}, []);

	if (!isMacHost()) return null;

	const mode = status?.mode ?? "auto";
	const setMode = async (next: ComputerAwakeMode): Promise<void> => {
		const awake = window.zuse?.computerAwake;
		if (awake === undefined || saving) return;
		setSaving(true);
		setError(null);
		try {
			setStatus(await awake.setMode(next));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsGroup
			title="Power"
			description="Keep this Mac available for local agents and remote control."
		>
			<SettingsRow
				title="Keep Mac awake"
				description={computerAwakeModeDescription(mode)}
				action={
					<Select
						value={mode}
						onValueChange={(value) => void setMode(value as ComputerAwakeMode)}
						items={COMPUTER_AWAKE_OPTIONS}
					>
						<SelectTrigger
							className="h-7 w-28"
							disabled={saving}
							aria-label="Keep Mac awake"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectPopup>
							{COMPUTER_AWAKE_OPTIONS.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									{option.label}
								</SelectItem>
							))}
						</SelectPopup>
					</Select>
				}
			>
				<div className="flex flex-col gap-1 text-[11px] leading-snug text-muted-foreground">
					<p>{error ?? computerAwakeStatusText(status)}</p>
					<p>
						The display may turn off. Closed-lid operation is best effort and
						depends on macOS hardware and power policy.
					</p>
				</div>
			</SettingsRow>
		</SettingsGroup>
	);
}

function GeneralPane() {
	const appearanceMode = useSettingsStore((s) => s.appearanceMode);
	const setAppearanceMode = useSettingsStore((s) => s.setAppearanceMode);
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
		isLoading,
		isUnavailable,
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
				) : isLoading ? (
					<SettingsRow
						title={isUnavailable ? "Account unavailable" : "Checking account…"}
						description={
							isUnavailable
								? "Reconnect this computer to load the existing WorkOS session."
								: "Loading the saved WorkOS session from this computer."
						}
					/>
				) : (
					<SettingsRow
						title="Not signed in"
						description="You're using Zuse (Beta) locally without an account. Sign in to sync and unlock remote agents."
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

			<ComputerAwakeSettings />

			<SettingsGroup title="Notifications">
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
				description="Controls how Zuse (Beta) names new worktree-backed branches."
			>
				<SettingsRow
					title="Branch naming"
					description="After the first submitted turn completes successfully, each unnamed session receives one title, the chat receives one title from its initial session, and a fresh unpublished worktree branch receives a separate semantic name in this shape."
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
								className="h-7 w-full max-w-[260px] rounded-md border border-input bg-card px-2.5 text-xs text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/24"
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

function DefaultModelsPane() {
	const defaultProviderId = useSettingsStore((s) => s.defaultProviderId);
	const defaultRuntimeMode = useSettingsStore((s) => s.defaultRuntimeMode);
	const setDefaultRuntimeMode = useSettingsStore(
		(s) => s.setDefaultRuntimeMode,
	);

	return (
		<SettingsGroup
			title="Chat defaults"
			description="These choices apply when you start a new chat. You can still change either one from the composer."
		>
			<SettingsRow
				title="Default model"
				description={`Model for new chats · ${PROVIDER_LABEL[defaultProviderId]}`}
				action={
					<ModelPicker
						mode="default"
						triggerClassName="h-7 w-64 max-w-[40vw] justify-between rounded-md border border-input bg-card px-2.5 text-xs hover:bg-muted"
					/>
				}
			/>
			<SettingsRow
				title="Default permission mode"
				description="How new chats handle tool calls. Each chat can override this from the composer."
				action={
					<Select
						value={defaultRuntimeMode}
						onValueChange={(value) =>
							setDefaultRuntimeMode(value as RuntimeMode)
						}
						items={MODES_ORDER.map((mode) => ({
							label: MODE_META[mode].label,
							value: mode,
						}))}
					>
						<SelectTrigger
							size="sm"
							className="h-7 w-64 max-w-[40vw] rounded-md px-2.5"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectPopup>
							{MODES_ORDER.map((mode) => (
								<SelectItem key={mode} value={mode}>
									{MODE_META[mode].label}
								</SelectItem>
							))}
						</SelectPopup>
					</Select>
				}
			/>
		</SettingsGroup>
	);
}

function ProvidersPane() {
	const environmentId = useEnvironmentCatalogStore(
		(state) => state.activeEnvironmentId,
	);
	const availability = useProvidersStore((s) => s.availability);
	const loading = useProvidersStore((s) => s.loading);
	const availabilityLoaded = useProvidersStore((s) => s.availabilityLoaded);
	const error = useProvidersStore((s) => s.error);
	const load = useProvidersStore((s) => s.load);
	const refresh = useProvidersStore((s) => s.refresh);

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
		"kiro",
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
		<SettingsFrame
			title="Agent providers"
			description="Enable the coding agents you use, verify their local setup, and control which models appear in Zuse."
			flush
			trailing={
				<div className="flex items-center gap-2">
					<span className="max-w-48 truncate text-[10px] text-muted-foreground">
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
			}
		>
			<div className="flex min-h-10 items-center border-b border-border/60 px-3 py-1.5">
				<div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
					<SegmentedTabs
						value={selectedProvider}
						onValueChange={setSelectedProvider}
						ariaLabel="Provider settings"
						equalWidth={false}
						className="w-max min-w-full"
						options={providers.map((pid) => ({
							value: pid,
							label: (
								<>
									<ProviderIcon providerId={pid} className="size-3.5" />
									<span>{PROVIDER_LABEL[pid]}</span>
								</>
							),
						}))}
					/>
				</div>
			</div>

			<div className="min-h-0 px-4 pb-1">
				<ProviderCard
					environmentId={environmentId}
					providerId={selectedProvider}
					availability={availabilityById.get(selectedProvider)}
					loading={isInitialProviderAvailabilityLoading(
						loading,
						availabilityLoaded,
					)}
					layout="page"
				/>
			</div>
		</SettingsFrame>
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
		<SharedSettingsFrame
			title={title}
			action={trailing}
			description={description}
			bodyClassName={bodyClassName}
			flush={flush}
		>
			{children}
		</SharedSettingsFrame>
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
	const fallbackProvider = ready[0];
	if (fallbackProvider === undefined) return null;
	const provider = ready.includes(settings.defaultProviderId)
		? settings.defaultProviderId
		: fallbackProvider;
	const model = settings.defaultModelByProvider[provider];
	return {
		providerId: provider,
		model,
		runtimeMode: settings.defaultRuntimeMode,
	};
}

export { PROVIDER_LABEL } from "../lib/provider-labels.ts";
export type { FolderId };
