import "@zuse/i18n/english/settings";
import "@zuse/i18n/english/plugins";
import type { IconSvgElement } from "@hugeicons/react";
import type { WorkspaceScope } from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
import {
	BrowserIcon,
	CloudIcon,
	DocumentAttachmentIcon,
	KeyboardIcon,
	PackageIcon,
	PlugSocketIcon,
	PuzzleIcon,
	Settings01Icon,
	SmartPhone01Icon,
	TaskDone01Icon,
	TestTubeIcon,
	UserGroupIcon,
} from "@zuse/icons/solid-rounded";
import type { SettingsSection } from "../store/ui.ts";
import { cloudWorkspaceBetaAvailable } from "./cloud-machines-availability.ts";

export type SettingsNavigationItem = {
	readonly id: string;
	readonly label: string;
	readonly Icon: IconSvgElement;
	readonly section: SettingsSection;
};

const TOP_RAIL: ReadonlyArray<SettingsNavigationItem> = [
	{
		id: "general",
		get label() {
			return uiMessage("settings:settings_navigation_general");
		},
		Icon: Settings01Icon,
		section: { kind: "general" },
	},
	{
		id: "providers",
		get label() {
			return uiMessage("settings:settings_navigation_providers");
		},
		Icon: PackageIcon,
		section: { kind: "providers" },
	},
	{
		id: "defaults",
		get label() {
			return uiMessage("settings:settings_navigation_default_models");
		},
		Icon: TaskDone01Icon,
		section: { kind: "defaults" },
	},
	{
		id: "plugins",
		get label() {
			return uiMessage("plugins:plugins_title");
		},
		Icon: PlugSocketIcon,
		section: { kind: "plugins" },
	},
	{
		id: "devices",
		get label() {
			return uiMessage("settings:settings_navigation_remote_access");
		},
		Icon: SmartPhone01Icon,
		section: { kind: "devices" },
	},
	{
		id: "machines",
		get label() {
			return uiMessage("settings:settings_navigation_cloud_workspaces_beta");
		},
		Icon: CloudIcon,
		section: { kind: "machines" },
	},
	{
		id: "browser",
		get label() {
			return uiMessage("settings:settings_navigation_browser");
		},
		Icon: BrowserIcon,
		section: { kind: "browser" },
	},
	{
		id: "pokedex",
		get label() {
			return uiMessage("settings:settings_navigation_pokedex");
		},
		Icon: TaskDone01Icon,
		section: { kind: "pokedex" },
	},
	{
		id: "shortcuts",
		get label() {
			return uiMessage("settings:settings_navigation_keyboard_shortcuts");
		},
		Icon: KeyboardIcon,
		section: { kind: "shortcuts" },
	},
	{
		id: "diagnostics",
		get label() {
			return uiMessage("settings:settings_navigation_diagnostics");
		},
		Icon: DocumentAttachmentIcon,
		section: { kind: "diagnostics" },
	},
	// Dev-only visual playground (accent swatches + workflow chip/button
	// showcase). Filtered out of production bundles below.
	{
		id: "developer",
		get label() {
			return uiMessage("settings:settings_navigation_developer");
		},
		Icon: TestTubeIcon,
		section: { kind: "developer" },
	},
];

const CLOUD_MACHINES_AVAILABLE = cloudWorkspaceBetaAvailable();

/**
 * Organization workspaces have their own rail. Personal settings have no
 * organization features; the workspace switcher creates and joins them.
 */
export function settingsNavigationFor(
	_section: SettingsSection,
	desktop: boolean,
	scope?: WorkspaceScope,
) {
	if (scope?.kind === "organization") return ORGANIZATION_NAVIGATION;
	return SETTINGS_NAVIGATION.filter(
		(item) => desktop || item.section.kind !== "machines",
	);
}

export const ORGANIZATION_NAVIGATION: ReadonlyArray<SettingsNavigationItem> = [
	...TOP_RAIL.filter((item) => item.id === "general"),
	{
		id: "organizations",
		get label() {
			return uiMessage("settings:organizations_members");
		},
		Icon: UserGroupIcon,
		section: { kind: "organizations" },
	},
	{
		id: "repositories",
		get label() {
			return uiMessage("settings:workspace_repositories_scripts");
		},
		Icon: PuzzleIcon,
		section: { kind: "cloud", page: "repositories" },
	},
	{
		id: "image",
		get label() {
			return uiMessage("settings:cloud_workspace_pool_cloud_image");
		},
		Icon: CloudIcon,
		section: { kind: "cloud", page: "image" },
	},
	{
		id: "agents",
		get label() {
			return uiMessage("settings:settings_navigation_providers");
		},
		Icon: PackageIcon,
		section: { kind: "cloud", page: "agents" },
	},
	...TOP_RAIL.filter((item) => item.id === "defaults"),
	{
		id: "billing",
		get label() {
			return uiMessage("settings:workspace_billing");
		},
		Icon: DocumentAttachmentIcon,
		section: { kind: "cloud", page: "billing" },
	},
	...TOP_RAIL.filter((item) =>
		["browser", "shortcuts", "diagnostics"].includes(item.id),
	),
];

export const SETTINGS_NAVIGATION: ReadonlyArray<SettingsNavigationItem> =
	TOP_RAIL.filter(
		(item) =>
			(item.id !== "developer" || import.meta.env.DEV) &&
			(item.id !== "machines" || CLOUD_MACHINES_AVAILABLE),
	);
