import "@zuse/i18n/english/settings";
import type { AccountAccessAuthKind } from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
import { SegmentedTabs } from "../ui/segmented-tabs.tsx";

const AUTH_METHOD_OPTIONS = [
	{
		value: "subscription",
		get label() {
			return uiMessage("settings:cloud_auth_method_tabs_subscription");
		},
	},
	{
		value: "api-key",
		get label() {
			return uiMessage("settings:cloud_auth_method_tabs_api_key");
		},
	},
	{
		value: "custom",
		get label() {
			return uiMessage("settings:cloud_auth_method_tabs_custom");
		},
	},
] as const;

export function CloudAuthMethodTabs({
	value,
	onValueChange,
}: {
	readonly value: AccountAccessAuthKind;
	readonly onValueChange: (value: AccountAccessAuthKind) => void;
}) {
	return (
		<SegmentedTabs
			value={value}
			options={AUTH_METHOD_OPTIONS}
			onValueChange={onValueChange}
			ariaLabel="Authentication method"
			className="w-full"
		/>
	);
}
