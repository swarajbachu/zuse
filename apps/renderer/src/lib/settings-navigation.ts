import "@zuse/i18n/english/settings";
import type { IconSvgElement } from "@hugeicons/react";
import { message as uiMessage } from "@zuse/i18n";
import {
	BrowserIcon,
	ConnectIcon,
	DocumentAttachmentIcon,
	KeyboardIcon,
	PackageIcon,
	PlugSocketIcon,
	Settings01Icon,
	SmartPhone01Icon,
	TaskDone01Icon,
	TestTubeIcon,
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
		id: "mcp",
		get label() {
			return uiMessage("settings:settings_navigation_mcp_servers");
		},
		Icon: PlugSocketIcon,
		section: { kind: "mcp" },
	},
	{
		id: "integrations",
		get label() {
			return uiMessage("settings:settings_navigation_integrations");
		},
		Icon: ConnectIcon,
		section: { kind: "integrations" },
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
		Icon: ConnectIcon,
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

export const SETTINGS_NAVIGATION: ReadonlyArray<SettingsNavigationItem> =
	TOP_RAIL.filter(
		(item) =>
			(item.id !== "developer" || import.meta.env.DEV) &&
			(item.id !== "machines" || CLOUD_MACHINES_AVAILABLE),
	);
