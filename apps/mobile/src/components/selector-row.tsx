import { Check, ChevronsUpDown } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";

import { Button } from "~/components/ui/button";
import { colors } from "~/theme";

export type SelectorOption = {
	key: string;
	label: string;
	selected: boolean;
	onSelect: () => void;
};

/** Native iOS menus have a separate implementation; other platforms use this picker. */
export function SelectorRow({
	label,
	options,
	disabled = false,
	emptyLabel = "None",
	compact = false,
}: {
	symbol: string;
	label: string;
	options: readonly SelectorOption[];
	disabled?: boolean;
	emptyLabel?: string;
	compact?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const unavailable = disabled || options.length === 0;
	useEffect(() => {
		if (unavailable) setOpen(false);
	}, [unavailable]);
	return (
		<>
			<Pressable
				className={`${compact ? "h-7" : "h-11"} flex-row items-center gap-2`}
				accessibilityRole="button"
				accessibilityLabel={label}
				accessibilityState={{
					disabled: unavailable,
					expanded: open && !unavailable,
				}}
				disabled={unavailable}
				onPress={() => {
					if (!unavailable) setOpen(true);
				}}
			>
				<Text
					className="font-sans-medium text-[15px] text-foreground"
					numberOfLines={1}
				>
					{label || emptyLabel}
				</Text>
				<ChevronsUpDown size={11} color={colors.tertiaryFg} />
			</Pressable>
			<Modal
				visible={open && !unavailable}
				transparent
				animationType="fade"
				onRequestClose={() => setOpen(false)}
			>
				<View className="flex-1 items-center justify-center px-6">
					<Pressable
						className="absolute inset-0 bg-black/40"
						accessibilityRole="button"
						accessibilityLabel="Dismiss selection"
						onPress={() => setOpen(false)}
					/>
					<View
						className="max-h-[70%] w-full max-w-md gap-3 rounded-2xl bg-background p-4"
						accessibilityViewIsModal
					>
						<Text
							accessibilityRole="header"
							className="font-sans-medium text-foreground"
						>
							{label}
						</Text>
						<ScrollView accessibilityRole="menu">
							{options.map((option) => (
								<Pressable
									key={option.key}
									className="h-7 flex-row items-center justify-between gap-3"
									accessibilityRole="menuitem"
									accessibilityLabel={option.label}
									accessibilityState={{ selected: option.selected }}
									onPress={() => {
										if (unavailable) return;
										setOpen(false);
										option.onSelect();
									}}
								>
									<Text
										className="flex-1 font-sans text-foreground"
										numberOfLines={1}
									>
										{option.label}
									</Text>
									{option.selected ? (
										<Check size={16} color={colors.fg} />
									) : null}
								</Pressable>
							))}
						</ScrollView>
						<Button
							className="h-7 self-end"
							size="sm"
							variant="ghost"
							onPress={() => setOpen(false)}
						>
							Cancel
						</Button>
					</View>
				</View>
			</Modal>
		</>
	);
}
