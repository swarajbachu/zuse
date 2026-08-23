import { GitBranch } from "lucide-react-native";
import { Alert, Pressable } from "react-native";

import { colors } from "~/theme";

/** Non-iOS fallback for the iOS-native anchored fork menu. */
export function ForkFromMessageMenu({
	onForkInChat,
	onForkInCurrentWorktree,
	onForkInNewWorktree,
}: {
	onForkInChat: () => void;
	onForkInCurrentWorktree: () => void;
	onForkInNewWorktree: () => void;
}) {
	const openMenu = () => {
		Alert.alert("Fork from here", "Where should the new session live?", [
			{ text: "Cancel", style: "cancel" },
			{ text: "This chat", onPress: onForkInChat },
			{ text: "New chat · current worktree", onPress: onForkInCurrentWorktree },
			{ text: "New chat · isolated worktree", onPress: onForkInNewWorktree },
		]);
	};

	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel="Fork from here"
			hitSlop={8}
			className="h-9 w-9 items-center justify-center active:opacity-60"
			onPress={openMenu}
		>
			<GitBranch size={16} color={colors.secondaryFg} />
		</Pressable>
	);
}
