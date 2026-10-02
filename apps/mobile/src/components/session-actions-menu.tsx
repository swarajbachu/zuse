import { SelectorRow } from "./selector-row";

export function SessionActionsMenu(props: {
	isPinned: boolean;
	onNewChat: () => void;
	onPin?: () => void;
	onRenameChat?: () => void;
	onRenameSession?: () => void;
	onRenameBranch?: () => void;
	onThreads: () => void;
	onChanges: () => void;
	onFiles: () => void;
	onTerminal?: () => void;
	onOpenOnDesktop?: () => void;
	onShare?: () => void;
	onArchive?: () => void;
}) {
	const actions = [
		["new", "New chat", props.onNewChat],
		["share", "Share chat", props.onShare],
		["pin", props.isPinned ? "Unpin" : "Pin", props.onPin],
		["rename-chat", "Rename chat", props.onRenameChat],
		["rename-session", "Rename session", props.onRenameSession],
		["rename-branch", "Rename branch", props.onRenameBranch],
		["threads", "Threads", props.onThreads],
		["changes", "Changes", props.onChanges],
		["files", "Files", props.onFiles],
		["terminal", "Terminal", props.onTerminal],
		["desktop", "Open on desktop", props.onOpenOnDesktop],
		["archive", "Archive", props.onArchive],
	] as const;
	return (
		<SelectorRow
			compact
			symbol="ellipsis"
			label="Chat actions"
			options={actions.flatMap(([key, label, onSelect]) =>
				onSelect ? [{ key, label, selected: false, onSelect }] : [],
			)}
		/>
	);
}
