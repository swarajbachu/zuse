import type { ComponentProps } from "react";
import { ProviderIcon } from "../provider-icons.tsx";
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

/** Provider identity shown before a settings row title. */
export function CloudProviderTile({
	providerId,
}: {
	readonly providerId: ComponentProps<typeof ProviderIcon>["providerId"];
}) {
	return (
		<span className="flex size-6 items-center justify-center rounded-md bg-muted">
			<ProviderIcon providerId={providerId} />
		</span>
	);
}
