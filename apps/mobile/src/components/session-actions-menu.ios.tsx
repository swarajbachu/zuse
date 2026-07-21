import { Stack } from "expo-router";

import { colors } from "~/theme";

/**
 * Native session-actions menu. Chat-specific actions are hidden until the
 * remote chat id exists; workspace actions remain available immediately.
 */
export function SessionActionsMenu({
	isPinned,
	onNewChat,
	onPin,
	onRename,
	onThreads,
	onChanges,
	onFiles,
	onArchive,
}: {
	isPinned: boolean;
	onNewChat: () => void;
	onPin?: () => void;
	onRename?: () => void;
	onThreads: () => void;
	onChanges: () => void;
	onFiles: () => void;
	onArchive: () => void;
}) {
	return (
		<Stack.Toolbar placement="right">
			<Stack.Toolbar.Button
				icon="square.and.pencil"
				tintColor={colors.fg}
				onPress={onNewChat}
			/>
			<Stack.Toolbar.Menu icon="ellipsis" tintColor={colors.fg}>
				{onPin !== undefined ? (
					<Stack.Toolbar.MenuAction
						icon={isPinned ? "pin.slash" : "pin"}
						onPress={onPin}
					>
						{isPinned ? "Unpin" : "Pin"}
					</Stack.Toolbar.MenuAction>
				) : null}
				{onRename !== undefined ? (
					<Stack.Toolbar.MenuAction icon="pencil" onPress={onRename}>
						Rename
					</Stack.Toolbar.MenuAction>
				) : null}
				<Stack.Toolbar.MenuAction icon="rectangle.stack" onPress={onThreads}>
					Threads
				</Stack.Toolbar.MenuAction>
				<Stack.Toolbar.MenuAction
					icon="arrow.triangle.branch"
					onPress={onChanges}
				>
					Changes
				</Stack.Toolbar.MenuAction>
				<Stack.Toolbar.MenuAction icon="folder" onPress={onFiles}>
					Files
				</Stack.Toolbar.MenuAction>
				<Stack.Toolbar.MenuAction
					icon="archivebox"
					destructive
					onPress={onArchive}
				>
					Archive
				</Stack.Toolbar.MenuAction>
			</Stack.Toolbar.Menu>
		</Stack.Toolbar>
	);
}
