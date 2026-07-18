import { Host } from "@expo/ui";
import { Menu, Button as NativeButton } from "@expo/ui/swift-ui";

import { colors } from "~/theme";

const sf = (name: string) => name as never;

/**
 * Native composer action menu. Attachments launch system pickers and the two
 * send modes remain visible here instead of being buried in model settings.
 */
export function ComposerPlusMenu({
	goalMode,
	planMode,
	onPickImages,
	onPickFiles,
	onToggleGoal,
	onTogglePlan,
}: {
	goalMode: boolean;
	planMode: boolean;
	onPickImages: () => void;
	onPickFiles: () => void;
	onToggleGoal: (next: boolean) => void;
	onTogglePlan: (next: boolean) => void;
}) {
	return (
		<Host matchContents seedColor={colors.fg}>
			<Menu label="" systemImage="plus">
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
				<NativeButton
					label="Add goal"
					systemImage={goalMode ? sf("checkmark") : sf("target")}
					onPress={() => onToggleGoal(!goalMode)}
				/>
				<NativeButton
					label="Plan mode"
					systemImage={planMode ? sf("checkmark") : sf("list.bullet.rectangle")}
					onPress={() => onTogglePlan(!planMode)}
				/>
			</Menu>
		</Host>
	);
}
