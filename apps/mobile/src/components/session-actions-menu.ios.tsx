import { Host } from "@expo/ui";
import { Menu, Button as NativeButton } from "@expo/ui/swift-ui";

import { NEON_GREEN } from "~/theme";

/**
 * Header "…" menu for the session screen: Rename (hidden when the chat has no
 * id yet) and Archive. Native UIMenu via @expo/ui so it matches the platform.
 */
export function SessionActionsMenu({
	onRename,
	onArchive,
}: {
	onRename?: () => void;
	onArchive: () => void;
}) {
	return (
		<Host matchContents seedColor={NEON_GREEN}>
			<Menu label="" systemImage="ellipsis">
				{onRename !== undefined ? (
					<NativeButton
						label="Rename chat"
						systemImage="pencil"
						onPress={onRename}
					/>
				) : null}
				{/* biome-ignore lint/a11y/useValidAriaRole: @expo/ui maps this native role to UIMenu destructive styling. */}
				<NativeButton
					label="Archive chat"
					systemImage="archivebox"
					role="destructive"
					onPress={onArchive}
				/>
			</Menu>
		</Host>
	);
}
