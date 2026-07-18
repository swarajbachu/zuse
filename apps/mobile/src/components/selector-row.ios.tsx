import { Host } from "@expo/ui";
import { Menu, Button as NativeButton } from "@expo/ui/swift-ui";

export type SelectorOption = {
	key: string;
	label: string;
	selected: boolean;
	onSelect: () => void;
};

/**
 * Uses Menu's stable string/system-image label rather than HStackView. The
 * latter is unavailable in older development clients and can crash before the
 * React Native fallback renders.
 */
export function SelectorRow({
	symbol,
	label,
	options,
	disabled = false,
	emptyLabel = "None",
}: {
	symbol: string;
	label: string;
	options: readonly SelectorOption[];
	disabled?: boolean;
	emptyLabel?: string;
}) {
	return (
		<Host style={{ alignSelf: "stretch", height: 40 }}>
			<Menu label={label} systemImage={sf(symbol)}>
				{disabled || options.length === 0 ? (
					<NativeButton label={emptyLabel} onPress={() => {}} />
				) : (
					options.map((option) => (
						<NativeButton
							key={option.key}
							label={option.label}
							systemImage={option.selected ? sf("checkmark") : undefined}
							onPress={option.onSelect}
						/>
					))
				)}
			</Menu>
		</Host>
	);
}

const sf = (name: string) => name as never;
