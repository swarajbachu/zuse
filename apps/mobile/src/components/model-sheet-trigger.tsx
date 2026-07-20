import { Pressable, Text, View } from "react-native";

import {
	modelOptionsForProvider,
	reasoningValueForModel,
} from "~/lib/model-options";
import type { ModelModeValue } from "./model-mode-menu";
import { ProviderLogo } from "./provider-logo";

const labelForModel = (value: ModelModeValue): string =>
	modelOptionsForProvider(value.providerId).find(
		(model) => model.value === value.model,
	)?.label ?? value.model;

/** Shared 44pt trigger for the model sheet in new and existing chats. */
export function ModelSheetTrigger({
	value,
	onPress,
}: {
	value: ModelModeValue;
	onPress: () => void;
}) {
	const reasoning = reasoningValueForModel(
		value.providerId,
		value.model,
		value.modelOptions,
	);
	const modelLabel = [labelForModel(value), reasoning?.label]
		.filter((part): part is string => part !== undefined)
		.join(" ");
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel="Model settings"
			onPress={onPress}
			hitSlop={8}
			className="h-10 min-w-7 max-w-[150px] flex-shrink flex-row items-center gap-1.5 px-1 active:opacity-60"
		>
			<View
				collapsable={false}
				className="h-[18px] w-[18px] flex-none items-center justify-center"
			>
				<ProviderLogo providerId={value.providerId} size={18} />
			</View>
			<Text
				className="min-w-0 flex-shrink font-sans-medium text-[15px] text-foreground"
				numberOfLines={1}
			>
				{modelLabel}
			</Text>
		</Pressable>
	);
}
