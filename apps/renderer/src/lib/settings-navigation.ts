import type { IconSvgElement } from "@hugeicons/react";
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

export const SETTINGS_NAVIGATION: ReadonlyArray<SettingsNavigationItem> =
	TOP_RAIL.filter(
		(item) =>
			(item.id !== "developer" || import.meta.env.DEV) &&
			(item.id !== "machines" || CLOUD_MACHINES_AVAILABLE),
	);
