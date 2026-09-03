import type { ComponentProps } from "react";
import { SettingsGroup, SettingsRow } from "../ui/settings-panel.tsx";

export const COMPACT_CLOUD_ACTION =
	"h-7 pointer-coarse:after:min-h-7 pointer-coarse:after:min-w-7";

export function CloudSettingsGroup(
	props: ComponentProps<typeof SettingsGroup>,
) {
	return <SettingsGroup {...props} />;
}

export function CloudSettingsRow(props: ComponentProps<typeof SettingsRow>) {
	return <SettingsRow {...props} />;
}
