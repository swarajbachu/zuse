import { Host } from "@expo/ui";
import { Menu, Button as NativeButton } from "@expo/ui/swift-ui";

import { NEON_GREEN } from "~/theme";

/**
 * Native session-actions menu. Chat-specific actions are hidden until the
 * remote chat id exists; workspace actions remain available immediately.
 */
export function SessionActionsMenu({
	isPinned,
	onPin,
	onRename,
	onChanges,
	onFiles,
	onArchive,
}: {
	isPinned: boolean;
	onPin?: () => void;
	onRename?: () => void;
	onChanges: () => void;
	onFiles: () => void;
	onArchive: () => void;
}) {
	return (
		<Host matchContents seedColor={NEON_GREEN}>
			<Menu label="" systemImage="ellipsis">
				{onPin !== undefined ? (
					<NativeButton
						label={isPinned ? "Unpin" : "Pin"}
						systemImage={isPinned ? "pin.slash" : "pin"}
						onPress={onPin}
					/>
				) : null}
				{onRename !== undefined ? (
					<NativeButton
						label="Rename chat"
						systemImage="pencil"
						onPress={onRename}
					/>
				) : null}
				<NativeButton
					label="Changes"
					systemImage="arrow.triangle.branch"
					onPress={onChanges}
				/>
				<NativeButton label="Files" systemImage="folder" onPress={onFiles} />
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
