import { Host } from "@expo/ui";
import {
	BottomSheet,
	Form,
	Image,
	Label,
	Picker,
	Section,
	Text,
} from "@expo/ui/swift-ui";
import { padding, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import type { ProviderId, RuntimeMode } from "@zuse/contracts";

import {
	defaultModelOptions,
	modelOptionsForProvider,
	providerOptions,
	RUNTIME_OPTIONS,
	reasoningValueForModel,
} from "~/lib/model-options";
import { PROVIDER_NATIVE_ASSET_NAMES } from "~/lib/provider-logos";
import { colors } from "~/theme";
import type { ModelModeValue } from "./model-mode-menu";

/**
 * The model / mode picker as a real native `@expo/ui` BottomSheet: a SwiftUI
 * `Form` of menu-style `Picker`s that adapts to light and dark automatically
 * (system material background, no hardcoded colors). Presented in-place from the
 * composer via `open`, so there's no route/header.
 */
export function ModelSheet({
	open,
	onOpenChange,
	value,
	availableProviders,
	canChangeProvider,
	canChangeReasoning,
	onChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	value: ModelModeValue;
	availableProviders?: readonly ProviderId[] | null;
	canChangeProvider: boolean;
	canChangeReasoning: boolean;
	onChange: (value: ModelModeValue) => void;
}) {
	const reasoning = reasoningValueForModel(
		value.providerId,
		value.model,
		value.modelOptions,
	);
	const providers = providerOptions().filter((provider) => {
		if (!canChangeProvider) return provider.value === value.providerId;
		if (availableProviders == null) return true;
		return (
			provider.value === value.providerId ||
			availableProviders.includes(provider.value)
		);
	});
	const models = modelOptionsForProvider(value.providerId);

	return (
		<Host matchContents seedColor={colors.fg}>
			<BottomSheet
				isPresented={open}
				onIsPresentedChange={onOpenChange}
				fitToContents
			>
				<Form>
					<Section title="Model">
						{canChangeProvider && providers.length > 1 ? (
							<Picker
								label="Provider"
								systemImage="cpu"
								selection={value.providerId}
								onSelectionChange={(providerId) => {
									if (!canChangeProvider) return;
									const id = providerId as ProviderId;
									const nextModel =
										modelOptionsForProvider(id)[0]?.value ?? value.model;
									onChange({
										...value,
										providerId: id,
										model: nextModel,
										modelOptions: defaultModelOptions(id, nextModel),
									});
								}}
								modifiers={[pickerStyle("menu")]}
							>
								{providers.map((provider) => (
									<Label
										key={provider.value}
										title={`\u00a0\u00a0${provider.label}`}
										icon={
											<Image
												assetName={PROVIDER_NATIVE_ASSET_NAMES[provider.value]}
												size={17}
												color={colors.fg}
												modifiers={[padding({ trailing: 6 })]}
											/>
										}
										modifiers={[tag(provider.value)]}
									/>
								))}
							</Picker>
						) : null}
						<Picker
							label="Model"
							systemImage="sparkles"
							selection={value.model}
							onSelectionChange={(model) =>
								onChange({
									...value,
									model: model as string,
									modelOptions: defaultModelOptions(
										value.providerId,
										model as string,
									),
								})
							}
							modifiers={[pickerStyle("menu")]}
						>
							{models.map((model) =>
								canChangeProvider ? (
									<Text key={model.value} modifiers={[tag(model.value)]}>
										{model.label}
									</Text>
								) : (
									<Label
										key={model.value}
										title={model.label}
										icon={
											<Image
												assetName={
													PROVIDER_NATIVE_ASSET_NAMES[value.providerId]
												}
												size={17}
												color={colors.fg}
												modifiers={[padding({ trailing: 6 })]}
											/>
										}
										modifiers={[tag(model.value)]}
									/>
								),
							)}
						</Picker>
						{canChangeReasoning && reasoning !== null ? (
							<Picker
								label="Intelligence"
								systemImage="gauge.with.dots.needle.67percent"
								selection={reasoning.value}
								onSelectionChange={(id) =>
									onChange({
										...value,
										modelOptions: {
											...(value.modelOptions ?? {}),
											[reasoning.descriptor.id]: id as string,
										},
									})
								}
								modifiers={[pickerStyle("menu")]}
							>
								{reasoning.descriptor.options.map((option) => (
									<Text key={option.id} modifiers={[tag(option.id)]}>
										{option.label}
									</Text>
								))}
							</Picker>
						) : null}
					</Section>
					<Section title="Permissions">
						<Picker
							label="Approval"
							systemImage="checkmark.shield"
							selection={value.runtimeMode}
							onSelectionChange={(runtimeMode) =>
								onChange({ ...value, runtimeMode: runtimeMode as RuntimeMode })
							}
							modifiers={[pickerStyle("menu")]}
						>
							{RUNTIME_OPTIONS.map((option) => (
								<Text key={option.value} modifiers={[tag(option.value)]}>
									{option.label}
								</Text>
							))}
						</Picker>
					</Section>
				</Form>
			</BottomSheet>
		</Host>
	);
}
