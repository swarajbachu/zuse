import { Host } from "@expo/ui";
import { Image, Menu, Button as NativeButton } from "@expo/ui/swift-ui";
import { frame } from "@expo/ui/swift-ui/modifiers";

import { colors } from "~/theme";

const sf = (name: string) => name as never;

/**
 * Native composer action menu. Attachments launch system pickers and the two
 * send modes remain visible here instead of being buried in model settings.
 */
export function ComposerPlusMenu({
	goalMode,
	goalSupported,
	planMode,
	onPickImages,
	onPickFiles,
	onToggleGoal,
	onTogglePlan,
}: {
	goalMode: boolean;
	goalSupported: boolean;
	planMode: boolean;
	onPickImages: () => void;
	onPickFiles: () => void;
	onToggleGoal: (next: boolean) => void;
	onTogglePlan: (next: boolean) => void;
}) {
	return (
		<Host
			ignoreSafeArea="keyboard"
			seedColor={colors.fg}
			style={{ width: 40, height: 40 }}
		>
			<Menu
				label={
					<Image
						systemName={sf("plus")}
						size={20}
						color={colors.fg}
						modifiers={[frame({ width: 40, height: 40 })]}
					/>
				}
			>
				<NativeButton
					label="Choose photos"
					systemImage={sf("photo.on.rectangle")}
					onPress={onPickImages}
				/>
				<NativeButton
					label="Choose files"
					systemImage={sf("doc")}
					onPress={onPickFiles}
				/>
				{goalSupported ? (
					<NativeButton
						label="Add goal"
						systemImage={goalMode ? sf("checkmark") : sf("target")}
						onPress={() => onToggleGoal(!goalMode)}
					/>
				) : null}
				<NativeButton
					label="Plan mode"
					systemImage={planMode ? sf("checkmark") : sf("checklist")}
					onPress={() => onTogglePlan(!planMode)}
				/>
			</Menu>
		</Host>
	);
}
