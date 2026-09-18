import { formatDate as formatUiDate } from "@zuse/i18n";
import { isInputComposing } from "../lib/input-composition.ts";
import "@zuse/i18n/english/settings";
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
	PROVIDER_IDS,
	type ProviderId,
	type RuntimeMode,
	visibleModelsForProvider,
} from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
import { RichMessage, useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	Alert01Icon,
	Delete02Icon,
	Folder01Icon,
	PencilEdit01Icon,
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
import { SETTINGS_NAVIGATION as VISIBLE_RAIL } from "~/lib/settings-navigation.ts";
import {
	formatRelativeTime,
	useRelativeTimeTick,
} from "~/lib/use-relative-time.ts";
import { cn } from "~/lib/utils";
import { useModelCatalogStore } from "~/store/model-catalog";
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
import { LanguageSelector } from "./language-selector.tsx";
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
import { UpdateChannelSettings } from "./settings/update-channel-settings.tsx";
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

const CLOUD_MACHINES_AVAILABLE = cloudWorkspaceBetaAvailable();
/**
 * Two-pane settings surface. The left rail navigates between global
 * sections (General / Models & Providers / Workspace) and per-repository
 * settings; the right pane renders the active section's form.
 */
export function SettingsPage() {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

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
					aria-label={uiMessage("settings:settings_page_back_to_app")}
					className="flex items-center gap-1 rounded p-1 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground [-webkit-app-region:no-drag]"
				>
					<ChevronLeft className="size-3.5" />
					<span>{uiMessage("settings:settings_page_back_to_app")}</span>
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
	useUiMessages(["common", "settings"]);

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
						<RichMessage
							id="settings:settings_page_repositories_sentence"
							values={{ value: folders.length }}
							components={{
								part0: (
									<span className="text-[11px] font-medium tracking-wide text-muted-foreground/80" />
								),
								part1: (
									<span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground" />
								),
							}}
						/>
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
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	const { title, subtitle } = useMemo(() => {
		if (section.kind === "general") {
			return {
				title: uiMessage("settings:settings_page_general"),
				subtitle: "Defaults for new chats.",
			};
		}
		if (section.kind === "providers") {
			return {
				title: uiMessage("settings:settings_page_providers"),
				subtitle:
					"Verify what's installed, signed in, and which subscription each provider runs on.",
			};
		}
		if (section.kind === "defaults") {
			return {
				title: uiMessage("settings:settings_page_default_models"),
				subtitle: "Choose how new chats start.",
			};
		}
		if (section.kind === "integrations") {
			return {
				title: uiMessage("settings:settings_page_integrations"),
				subtitle:
					"Connect issue workspaces and bring tickets into new sessions.",
			};
		}
		if (section.kind === "mcp") {
			return {
				title: uiMessage("settings:settings_page_mcp_servers"),
				subtitle:
					"Configured servers and provider-managed connectors, with live availability and authentication.",
			};
		}
		if (section.kind === "devices") {
			return {
				title: uiMessage("settings:settings_page_remote_access"),
				subtitle:
					"Use this computer from your phone, a browser, or another computer.",
			};
		}
		if (section.kind === "machines") {
			return {
				title: uiMessage("settings:settings_page_cloud_workspaces_beta"),
				subtitle:
					"Connect GitHub and your coding agents, then keep work running when this app is closed.",
			};
		}
		if (section.kind === "browser") {
			return {
				title: uiMessage("settings:settings_page_browser"),
				subtitle: "Sessions, password filling, privacy, and agent access.",
			};
		}
		if (section.kind === "pokedex") {
			return {
				title: uiMessage("settings:settings_page_pokedex"),
				subtitle: "Unlocked Pokémon from all worktrees.",
			};
		}
		if (section.kind === "diagnostics") {
			return {
				title: uiMessage("settings:settings_page_diagnostics"),
				subtitle:
					"Inspect failures, traces, processes, resources, and local support bundles.",
			};
		}
		if (section.kind === "shortcuts") {
			return {
				title: uiMessage("settings:settings_page_keyboard_shortcuts"),
				subtitle: "These also appear under the menu bar.",
			};
		}
		if (section.kind === "developer") {
			return {
				title: uiMessage("settings:settings_page_developer"),
				subtitle:
					"Accent palette + workflow chip/button states (dev builds only).",
			};
		}
		const f = folders.find((x) => x.id === section.projectId);
		return {
			title: f?.name ?? "Repository",
			subtitle: f?.path !== undefined ? displayPath(f.path) : "",
		};
	}, [section, folders, uiMessage]);
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
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

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
			: `${status.importedCookieCount} cookies across ${status.importedDomainCount} domains${status.lastImportTime ? ` · Imported ${formatUiDate(new Date(status.lastImportTime), { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })}` : ""}`;

	return (
		<div className="flex flex-col gap-4">
			<SettingsGroup
				title={uiMessage("settings:settings_page_browser_sessions")}
				description={uiMessage(
					"settings:settings_page_copy_valid_cookies_from_a_local_browser_profile_into_the_built_in_brow",
				)}
			>
				<SettingsRow
					title={uiMessage("settings:settings_page_import_source")}
					description={
						selectedProfile === undefined
							? (status.message ?? "No supported browser profile found.")
							: uiMessage(
									"settings:settings_page_close_before_importing_macos_may_request_safe_storage_access",
									{ source: String(selectedProfile.source) },
								)
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
							{uiMessage("settings:settings_page_import")}
						</Button>
					</div>
				</SettingsRow>
				<SettingsRow
					title={uiMessage("settings:settings_page_imported_data")}
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
							{uiMessage("settings:settings_page_clear_imported")}
						</Button>
					}
				/>
			</SettingsGroup>

			<SettingsGroup
				title={uiMessage("settings:settings_page_privacy")}
				description={uiMessage(
					"settings:settings_page_built_in_browser_data_stays_in_an_isolated_in_memory_partition_explici",
				)}
			>
				<SettingsRow
					title={uiMessage("settings:settings_page_browsing_data")}
					description={uiMessage(
						"settings:settings_page_remove_cookies_site_storage_and_cache_from_the_current_built_in_browse",
					)}
					action={
						<Button
							size="sm"
							variant="destructive-outline"
							onClick={() => setClearOpen(true)}
						>
							{uiMessage("settings:settings_page_clear_all")}
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
						<AlertDialogTitle>
							{uiMessage("settings:settings_page_clear_browsing_data")}
						</AlertDialogTitle>
						<AlertDialogDescription className="text-xs">
							{uiMessage(
								"settings:settings_page_this_removes_cookies_site_storage_and_cache_from_the_built_in_browser",
							)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter className="px-4 py-2">
						<AlertDialogClose render={<Button size="xs" variant="ghost" />}>
							{uiMessage("common:cancel")}
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
							{uiMessage("settings:settings_page_clear_data")}
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
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

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
					<RichMessage
						id="settings:settings_page_dummy_test_logins_only_never_store_a_real_or_production_pass_sentence"
						components={{ part0: <strong className="font-semibold" /> }}
					/>
				</span>
			</div>

			<SettingsFrame
				title={uiMessage("settings:settings_page_saved_logins")}
				description={uiMessage(
					"settings:settings_page_the_agent_calls_browser_login_with_a_site_s_origin_you_ll_always_be_as",
				)}
			>
				<div className="flex flex-col gap-3">
					{creds.length === 0 ? (
						<p className="text-[13px] text-muted-foreground">
							{uiMessage("settings:settings_page_no_saved_logins_yet")}
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
											{c.username ||
												uiMessage("settings:settings_page_no_username")}{" "}
											· ••••••••
										</p>
									</div>
									<button
										type="button"
										onClick={() => void remove(c.origin)}
										aria-label={uiMessage(
											"settings:settings_page_remove_login_for",
											{ value1: String(c.origin) },
										)}
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
							placeholder={uiMessage(
								"settings:settings_page_origin_https_app_example_com",
							)}
							value={origin}
							onChange={setOrigin}
						/>
						<CredInput
							placeholder={uiMessage("settings:settings_page_username_email")}
							value={username}
							onChange={setUsername}
						/>
						<CredInput
							placeholder={uiMessage("settings:settings_page_password_dummy")}
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
								{uiMessage("settings:settings_page_add_login")}
							</Button>
						</div>
					</div>
				</div>
			</SettingsFrame>
		</div>
	);
}

function NotchSettingsPane() {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

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
				title={uiMessage("settings:settings_page_notch_tray")}
				description={uiMessage(
					"settings:settings_page_show_active_agents_near_the_macbook_notch_hover_the_notch_area_to_expa",
				)}
			>
				<SettingsRow
					title={uiMessage("settings:settings_page_enable_notch_tray")}
					description={uiMessage(
						"settings:settings_page_show_running_agents_pending_approvals_questions_plans_completions_and",
					)}
					action={<Switch checked={enabled} onCheckedChange={setEnabled} />}
				/>
				<SettingsRow
					title={uiMessage("settings:settings_page_keep_tray_expanded")}
					description={uiMessage(
						"settings:settings_page_keep_the_agent_list_open_instead_of_only_expanding_while_the_pointer_i",
					)}
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
				title={uiMessage("settings:settings_page_what_appears")}
				description={uiMessage(
					"settings:settings_page_the_tray_is_intentionally_quiet_it_shows_actionable_agent_states_first",
				)}
			>
				<ul className="list-disc space-y-1 pl-4 text-[13px] leading-relaxed text-muted-foreground">
					<li>
						{uiMessage(
							"settings:settings_page_permission_requests_questions_and_plan_approvals",
						)}
					</li>
					<li>
						{uiMessage(
							"settings:settings_page_running_agents_as_compact_status_circles",
						)}
					</li>
					<li>
						{uiMessage(
							"settings:settings_page_completed_turns_and_failures_from_background_chats",
						)}
					</li>
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
		get label() {
			return uiMessage("settings:settings_page_username_branch");
		},
		example: "swarajbachu/dark-mode",
	},
	slug: {
		get label() {
			return uiMessage("settings:settings_page_branch_only");
		},
		example: "dark-mode",
	},
	"feat-slug": {
		get label() {
			return uiMessage("settings:settings_page_feat_branch");
		},
		example: "feat/dark-mode",
	},
	custom: {
		get label() {
			return uiMessage("settings:settings_page_custom_prefix_2");
		},
		example: "prefix/dark-mode",
	},
};

const APPEARANCE_OPTIONS: ReadonlyArray<{
	readonly value: AppearanceMode;
	readonly label: string;
}> = [
	{
		value: "system",
		get label() {
			return uiMessage("settings:settings_page_system");
		},
	},
	{
		value: "light",
		get label() {
			return uiMessage("settings:settings_page_light");
		},
	},
	{
		value: "dark",
		get label() {
			return uiMessage("settings:settings_page_dark");
		},
	},
];

const COMPUTER_AWAKE_OPTIONS: ReadonlyArray<{
	readonly value: ComputerAwakeMode;
	readonly label: string;
}> = [
	{
		value: "off",
		get label() {
			return uiMessage("settings:settings_page_off");
		},
	},
	{
		value: "auto",
		get label() {
			return uiMessage("settings:settings_page_auto");
		},
	},
	{
		value: "always",
		get label() {
			return uiMessage("settings:settings_page_always");
		},
	},
];

function ComputerAwakeSettings() {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

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
			title={uiMessage("settings:settings_page_power")}
			description={uiMessage(
				"settings:settings_page_keep_this_mac_available_for_local_agents_and_remote_control",
			)}
		>
			<SettingsRow
				title={uiMessage("settings:settings_page_keep_mac_awake")}
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
							aria-label={uiMessage("settings:settings_page_keep_mac_awake")}
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
						{uiMessage(
							"settings:settings_page_the_display_may_turn_off_closed_lid_operation_is_best_effort_and_depen",
						)}
					</p>
				</div>
			</SettingsRow>
		</SettingsGroup>
	);
}

function GeneralPane() {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

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
				title={uiMessage("settings:settings_page_account")}
				description={uiMessage(
					"settings:settings_page_sign_in_to_sync_your_account_across_devices_and_soon_drive_remote_agen",
				)}
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
										if (isInputComposing(e)) return;

										if (e.key === "Enter") {
											e.currentTarget.blur();
										}
										if (e.key === "Escape") {
											setNameDraft(displayName);
											setEditingName(false);
										}
									}}
									placeholder={uiMessage("settings:settings_page_your_name")}
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
										aria-label={uiMessage(
											"settings:settings_page_edit_display_name",
										)}
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
							{uiMessage("common:signOut")}
						</Button>
					</div>
				) : isLoading ? (
					<SettingsRow
						title={
							isUnavailable
								? uiMessage("settings:settings_page_account_unavailable")
								: uiMessage("settings:settings_page_checking_account")
						}
						description={
							isUnavailable
								? uiMessage(
										"settings:settings_page_reconnect_this_computer_to_load_the_existing_workos_session",
									)
								: uiMessage(
										"settings:settings_page_loading_the_saved_workos_session_from_this_computer",
									)
						}
					/>
				) : (
					<SettingsRow
						title={uiMessage("settings:settings_page_not_signed_in")}
						description={uiMessage(
							"settings:settings_page_you_re_using_zuse_beta_locally_without_an_account_sign_in_to_sync_and",
						)}
						action={
							<Button
								variant="settings"
								size="sm"
								loading={signingIn}
								onClick={() => void signIn()}
							>
								{uiMessage("common:signIn")}
							</Button>
						}
					/>
				)}
			</SettingsGroup>

			<SettingsGroup
				title={uiMessage("settings:settings_page_appearance")}
				description={uiMessage(
					"settings:settings_page_choose_the_app_theme_or_follow_your_system_setting",
				)}
			>
				<SettingsRow
					title={uiMessage("settings:settings_page_theme")}
					description={uiMessage(
						"settings:settings_page_choose_the_app_theme_or_follow_your_system_setting",
					)}
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
				<LanguageSelector settingsRow />
			</SettingsGroup>

			<UpdateChannelSettings />

			<ComputerAwakeSettings />

			<SettingsGroup title={uiMessage("settings:settings_page_notifications")}>
				<SettingsRow
					title={uiMessage("settings:settings_page_agent_completion_sound")}
					description={uiMessage(
						"settings:settings_page_play_a_short_sound_when_any_agent_turn_finishes_including_agents_worki",
					)}
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
							{uiMessage("settings:settings_page_preview")}
						</Button>
					</div>
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup
				title={uiMessage("settings:settings_page_workspace_naming")}
				description={uiMessage(
					"settings:settings_page_controls_how_zuse_beta_names_new_worktree_backed_branches",
				)}
			>
				<SettingsRow
					title={uiMessage("settings:settings_page_branch_naming")}
					description={uiMessage(
						"settings:settings_page_after_the_first_submitted_turn_completes_successfully_each_unnamed_ses",
					)}
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
								{uiMessage("settings:settings_page_custom_prefix")}
							</label>
							<input
								id="branch-naming-prefix"
								type="text"
								value={prefixDraft}
								placeholder={uiMessage(
									"settings:settings_page_e_g_swaraj_or_team_wip",
								)}
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
								{uiMessage(
									"settings:settings_page_slash_joined_before_the_slug_letters_digits_slashes_and_dashes_leave_e",
								)}
							</p>
						</div>
					)}
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup title={uiMessage("settings:settings_page_setup")}>
				<SettingsRow
					title={uiMessage("settings:settings_page_onboarding")}
					description={uiMessage(
						"settings:settings_page_replay_the_first_launch_welcome_flow_your_existing_projects_and_creden",
					)}
					action={
						<Button
							variant="settings"
							size="sm"
							onClick={() => {
								setView("chat");
								setOnboardingCompleted(false);
							}}
						>
							{uiMessage("settings:settings_page_show_again")}
						</Button>
					}
				/>
			</SettingsGroup>
			<NotchSettingsPane />
		</div>
	);
}

function DefaultModelsPane() {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	const defaultProviderId = useSettingsStore((s) => s.defaultProviderId);
	const defaultRuntimeMode = useSettingsStore((s) => s.defaultRuntimeMode);
	const setDefaultRuntimeMode = useSettingsStore(
		(s) => s.setDefaultRuntimeMode,
	);

	return (
		<SettingsGroup
			title={uiMessage("settings:settings_page_chat_defaults")}
			description={uiMessage(
				"settings:settings_page_these_choices_apply_when_you_start_a_new_chat_you_can_still_change_eit",
			)}
		>
			<SettingsRow
				title={uiMessage("settings:settings_page_default_model")}
				description={uiMessage("settings:settings_page_model_for_new_chats", {
					value1: String(PROVIDER_LABEL[defaultProviderId]),
				})}
				action={
					<ModelPicker
						mode="default"
						triggerClassName="h-7 w-64 max-w-[40vw] justify-between rounded-md border border-input bg-card px-2.5 text-xs hover:bg-muted"
					/>
				}
			/>
			<SettingsRow
				title={uiMessage("settings:settings_page_default_permission_mode")}
				description={uiMessage(
					"settings:settings_page_how_new_chats_handle_tool_calls_each_chat_can_override_this_from_the_c",
				)}
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
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

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
	}, [availability, uiMessage]);

	const providers = PROVIDER_IDS;
	const [selectedProvider, setSelectedProvider] =
		useState<ProviderId>("claude");
	const availabilityById = useMemo(() => {
		const map = new Map<ProviderId, (typeof availability)[number]>();
		for (const a of availability) map.set(a.providerId, a);
		return map;
	}, [availability, uiMessage]);

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
			title={uiMessage("settings:settings_page_agent_providers")}
			description={uiMessage(
				"settings:settings_page_enable_the_coding_agents_you_use_verify_their_local_setup_and_control",
			)}
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
						aria-label={uiMessage(
							"settings:settings_page_refresh_provider_status",
						)}
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
						ariaLabel={uiMessage("common:provider_settings")}
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
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

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
						{uiMessage("settings:settings_page_inherit")}
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
						{uiMessage("settings:settings_page_custom")}
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
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	const modelEnabledByProvider = useSettingsStore(
		(s) => s.modelEnabledByProvider,
	);
	const catalog = useModelCatalogStore((s) => s.catalog);
	const models = visibleModelsForProvider(
		catalog,
		providerId,
		modelEnabledByProvider,
		{ includeModelId: value },
	);
	const normalizedValue =
		value !== null &&
		(models.some((m) => m.id === value) || models.length === 0)
			? value
			: (models[0]?.id ?? "");
	const items = useMemo(
		() => models.map((m) => ({ value: m.id, label: m.label })),
		[models, uiMessage],
	);
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-xs font-medium text-muted-foreground">
				{uiMessage("settings:settings_page_default_model")}
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
