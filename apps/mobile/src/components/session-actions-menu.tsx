// Non-iOS stub: the native UIMenu header action lives in the `.ios.tsx` twin.
// This app is iOS-first; on other platforms the header omits the "…" menu.
export function SessionActionsMenu(_props: {
	isPinned: boolean;
	onNewChat: () => void;
	onPin?: () => void;
	onRename?: () => void;
	onChanges: () => void;
	onFiles: () => void;
	onArchive: () => void;
}) {
	return null;
}
