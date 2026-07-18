import { Pressable, Text } from "react-native";

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
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel="Model settings"
			onPress={onPress}
			hitSlop={8}
			className="h-11 min-w-0 flex-row items-center gap-1.5 px-1 active:opacity-60"
		>
			<ProviderLogo providerId={value.providerId} size={16} />
			<Text
				className="max-w-[140px] font-sans-medium text-[15px] text-foreground"
				numberOfLines={1}
			>
				{labelForModel(value)}
			</Text>
			{reasoning ? (
				<Text className="font-sans text-[15px] text-muted-foreground">
					{reasoning.label}
				</Text>
			) : null}
		</Pressable>
	);
}
