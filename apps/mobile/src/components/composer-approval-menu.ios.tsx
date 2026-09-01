import { Host } from "@expo/ui";
import { Image, Menu, Button as NativeButton } from "@expo/ui/swift-ui";
import { accessibilityLabel, frame } from "@expo/ui/swift-ui/modifiers";
import type { ProviderId, RuntimeMode } from "@zuse/contracts";

import {
	runtimeOptionFor,
	runtimeOptionsForProvider,
} from "~/lib/model-options";

const sf = (name: string) => name as never;

/** The composer "hand" button: a native menu of approval (runtime) modes. */
export function ComposerApprovalMenu({
	runtimeMode,
	providerId,
	onChange,
}: {
	runtimeMode: RuntimeMode;
	providerId: ProviderId;
	onChange: (mode: RuntimeMode) => void;
}) {
	const selected = runtimeOptionFor(runtimeMode);
	const runtimeOptions = runtimeOptionsForProvider(providerId);

	return (
		<Host
			key={runtimeMode}
			ignoreSafeArea="keyboard"
			seedColor={selected.tint}
			style={{ width: 40, height: 40 }}
		>
			<Menu
				label={
					<Image
						systemName={sf(selected.systemImage)}
						size={19}
						color={selected.tint}
						modifiers={[frame({ width: 40, height: 40 })]}
					/>
				}
				modifiers={[accessibilityLabel(`${selected.label} permissions`)]}
			>
				{runtimeOptions.map((option) => (
					<NativeButton
						key={option.value}
						label={option.label}
						systemImage={
							runtimeMode === option.value
								? sf("checkmark")
								: sf(option.systemImage)
						}
						role={option.value === "full-access" ? "destructive" : undefined}
						onPress={() => onChange(option.value)}
					/>
				))}
			</Menu>
		</Host>
	);
}
