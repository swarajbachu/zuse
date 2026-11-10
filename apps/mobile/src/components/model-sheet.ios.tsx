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
import { padding, pickerStyle, tag, tint } from "@expo/ui/swift-ui/modifiers";
import type { ProviderId, RuntimeMode } from "@zuse/contracts";

import { RUNTIME_OPTIONS } from "~/lib/model-options";
import {
	type ModelSheetProps,
	modelSheetChoices,
	withModel,
	withProvider,
	withReasoning,
	withRuntimeMode,
} from "~/lib/model-sheet";
import { PROVIDER_NATIVE_ASSET_NAMES } from "~/lib/provider-logos";
import { activeModelCatalog } from "~/store/model-catalog";
import { colors } from "~/theme";

const sf = (name: string) => name as never;

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
	strictProviders = false,
	canChangeProvider,
	canChangeReasoning,
	onChange,
}: ModelSheetProps) {
	const {
		providers,
		showProviderPicker,
		models,
		reasoning,
		runtime: runtimeOption,
	} = modelSheetChoices(activeModelCatalog(), {
		value,
		availableProviders,
		strictProviders,
		canChangeProvider,
		canChangeReasoning,
	});

	return (
		<Host matchContents seedColor={colors.fg}>
			<BottomSheet
				isPresented={open}
				onIsPresentedChange={onOpenChange}
				fitToContents
			>
				<Form>
					<Section title="Model">
						{showProviderPicker ? (
							<Picker
								label="Provider"
								systemImage="cpu"
								selection={value.providerId}
								onSelectionChange={(providerId) =>
									onChange(
										withProvider(
											activeModelCatalog(),
											value,
											providerId as ProviderId,
										),
									)
								}
								modifiers={[pickerStyle("menu")]}
							>
								{providers.map((provider) => (
									<Label
										key={provider.value}
										title={`\u00a0\u00a0${provider.label}`}
										icon={
											<Image
												{...(PROVIDER_NATIVE_ASSET_NAMES[provider.value]
													? {
															assetName:
																PROVIDER_NATIVE_ASSET_NAMES[provider.value],
														}
													: { systemName: sf("sparkles") })}
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
							selection={value.model}
							onSelectionChange={(model) =>
								onChange(
									withModel(activeModelCatalog(), value, model as string),
								)
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
										title={`\u00a0\u00a0${model.label}`}
										icon={
											<Image
												{...(PROVIDER_NATIVE_ASSET_NAMES[value.providerId]
													? {
															assetName:
																PROVIDER_NATIVE_ASSET_NAMES[value.providerId],
														}
													: { systemName: sf("sparkles") })}
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
						{reasoning !== null ? (
							<Picker
								label="Intelligence"
								systemImage="gauge.with.dots.needle.67percent"
								selection={reasoning.value}
								onSelectionChange={(id) =>
									onChange(
										withReasoning(value, reasoning.descriptor.id, id as string),
									)
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
							systemImage={sf(runtimeOption.systemImage)}
							selection={value.runtimeMode}
							onSelectionChange={(runtimeMode) =>
								onChange(withRuntimeMode(value, runtimeMode as RuntimeMode))
							}
							modifiers={[pickerStyle("menu"), tint(runtimeOption.tint)]}
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
