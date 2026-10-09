import { Pressable, Text, View } from "react-native";

import { modelOptionsForProvider } from "~/lib/model-options";
import { activeModelCatalog } from "~/store/model-catalog";
import type { ModelModeValue } from "./model-mode-menu";
import { ProviderLogo } from "./provider-logo";

const labelForModel = (value: ModelModeValue): string =>
	modelOptionsForProvider(activeModelCatalog(), value.providerId).find(
		(model) => model.value === value.model,
	)?.label ?? value.model;

const LOGO_SIZE = 13;

/**
 * Compact model button for new and existing chats. Shows only the model name;
 * reasoning and approval live in the sheet. hitSlop keeps a 44pt target.
 */
export function ModelSheetTrigger({
	value,
	onPress,
}: {
	value: ModelModeValue;
	onPress: () => void;
}) {
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel="Model settings"
			onPress={onPress}
			hitSlop={10}
			className="h-8 min-w-6 max-w-[140px] flex-shrink flex-row items-center gap-1 px-1 active:opacity-60"
		>
			<View
				collapsable={false}
				style={{ width: LOGO_SIZE, height: LOGO_SIZE, flexShrink: 0 }}
				className="items-center justify-center"
			>
				<ProviderLogo providerId={value.providerId} size={LOGO_SIZE} />
			</View>
			<Text
				className="min-w-0 flex-shrink font-sans-medium text-[13px] text-muted-foreground"
				numberOfLines={1}
			>
				{labelForModel(value)}
			</Text>
		</Pressable>
	);
}
