import type { AccountAccessAuthKind } from "@zuse/contracts";
import { SegmentedTabs } from "../ui/segmented-tabs.tsx";

const AUTH_METHOD_OPTIONS = [
	{ value: "subscription", label: "Subscription" },
	{ value: "api-key", label: "API key" },
	{ value: "custom", label: "Custom" },
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
