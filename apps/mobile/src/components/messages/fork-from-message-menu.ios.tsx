import { Host } from "@expo/ui";
import { Image, Menu, Button as NativeButton } from "@expo/ui/swift-ui";
import { accessibilityLabel, frame } from "@expo/ui/swift-ui/modifiers";

import { colors } from "~/theme";

const sf = (name: string) => name as never;

/** A compact native counterpart to the desktop message fork menu. */
export function ForkFromMessageMenu({
	onForkInChat,
	onForkInCurrentWorktree,
	onForkInNewWorktree,
}: {
	onForkInChat: () => void;
	onForkInCurrentWorktree: () => void;
	onForkInNewWorktree: () => void;
}) {
	return (
		<Host
			ignoreSafeArea="keyboard"
			seedColor={colors.fg}
			style={{ width: 36, height: 36 }}
		>
			<Menu
				label={
					<Image
						systemName={sf("arrow.triangle.branch")}
						size={16}
						color={colors.secondaryFg}
						modifiers={[frame({ width: 36, height: 36 })]}
					/>
				}
				modifiers={[accessibilityLabel("Fork from here")]}
			>
				<NativeButton
					label="Fork in this chat"
					systemImage={sf("rectangle.stack.badge.plus")}
					onPress={onForkInChat}
				/>
				<Menu label="Fork to a new chat" systemImage={sf("plus.bubble")}>
					<NativeButton
						label="Use current worktree"
						systemImage={sf("folder")}
						onPress={onForkInCurrentWorktree}
					/>
					<NativeButton
						label="Create isolated worktree"
						systemImage={sf("arrow.triangle.branch")}
						onPress={onForkInNewWorktree}
					/>
				</Menu>
			</Menu>
		</Host>
	);
}
