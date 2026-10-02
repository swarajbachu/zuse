import type { ChatSharingDefaults } from "@zuse/contracts";
import { SelectorRow } from "./selector-row";

export function ChatSharingOptions<A extends ChatSharingDefaults>({
	value,
	organizationName,
	disabled,
	onChange,
}: {
	value: A;
	organizationName: string;
	disabled: boolean;
	onChange: (next: A) => void;
}) {
	return (
		<>
			<SelectorRow
				compact
				symbol="person.2"
				label={
					value.audience === "private"
						? "Private"
						: `Everyone in ${organizationName}`
				}
				disabled={disabled}
				options={(["private", "organization"] as const).map((audience) => ({
					key: audience,
					label:
						audience === "private"
							? "Private"
							: `Everyone in ${organizationName}`,
					selected: value.audience === audience,
					onSelect: () => onChange({ ...value, audience }),
				}))}
			/>
			<SelectorRow
				compact
				symbol="pencil"
				label={value.permission === "edit" ? "Edit" : "View"}
				disabled={disabled}
				options={(["view", "edit"] as const).map((permission) => ({
					key: permission,
					label: permission === "edit" ? "Edit" : "View",
					selected: value.permission === permission,
					onSelect: () => onChange({ ...value, permission }),
				}))}
			/>
		</>
	);
}
