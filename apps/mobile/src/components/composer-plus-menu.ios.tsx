import { Host } from "@expo/ui";
import { Menu, Button as NativeButton } from "@expo/ui/swift-ui";

const WHITE = "#ffffff";
const sf = (name: string) => name as never;

/**
 * The composer "+" button: a native menu. Plan mode is the primary action (it
 * drives the plan indicator on the composer); attachment sources are shown as
 * placeholders until wired up.
 */
export function ComposerPlusMenu({
	planMode,
	onTogglePlan,
}: {
	planMode: boolean;
	onTogglePlan: (next: boolean) => void;
}) {
	return (
		<Host matchContents seedColor={WHITE}>
			<Menu label="" systemImage="plus">
				<NativeButton
					label="Plan mode"
					systemImage={planMode ? sf("checkmark") : sf("list.bullet.rectangle")}
					onPress={() => onTogglePlan(!planMode)}
				/>
			</Menu>
		</Host>
	);
}
