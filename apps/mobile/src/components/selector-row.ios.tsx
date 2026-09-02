import { Host } from "@expo/ui";
import { Label, Menu, Button as NativeButton } from "@expo/ui/swift-ui";
import { frame } from "@expo/ui/swift-ui/modifiers";
import { useState } from "react";

import { colors } from "~/theme";

export type SelectorOption = {
	key: string;
	label: string;
	selected: boolean;
	onSelect: () => void;
};

/**
 * Uses the supported native Label primitive rather than HStackView. Giving the
 * host the React row width and the menu a leading-aligned SwiftUI frame avoids
 * intrinsic Menu padding escaping the host and clipping the leading content.
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
	const [rowWidth, setRowWidth] = useState(1);

	return (
		<Host
			matchContents={{ vertical: true }}
			seedColor={colors.fg}
			style={{ alignSelf: "stretch", height: 48 }}
			onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}
		>
			<Menu
				label={<Label title={label} systemImage={sf(symbol)} />}
				modifiers={[
					frame({ width: rowWidth, height: 48, alignment: "leading" }),
				]}
			>
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
