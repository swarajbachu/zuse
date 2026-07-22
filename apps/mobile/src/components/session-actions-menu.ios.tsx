import { Host } from "@expo/ui";
import { Image, Menu, Button as NativeButton } from "@expo/ui/swift-ui";
import { accessibilityLabel, frame } from "@expo/ui/swift-ui/modifiers";
import { SquarePen } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { colors } from "~/theme";

const sf = (name: string) => name as never;

/** Header actions backed by SwiftUI's native anchored UIMenu. */
export function SessionActionsMenu({
	isPinned,
	onNewChat,
	onPin,
	onRenameChat,
	onRenameSession,
	onRenameBranch,
	onThreads,
	onChanges,
	onFiles,
	onArchive,
}: {
	isPinned: boolean;
	onNewChat: () => void;
	onPin?: () => void;
	onRenameChat?: () => void;
	onRenameSession?: () => void;
	onRenameBranch?: () => void;
	onThreads: () => void;
	onChanges: () => void;
	onFiles: () => void;
	onArchive: () => void;
}) {
	return (
		<View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel="New chat"
				hitSlop={8}
				onPress={onNewChat}
				style={{
					width: 40,
					height: 40,
					alignItems: "center",
					justifyContent: "center",
				}}
			>
				<SquarePen size={20} color={colors.fg} />
			</Pressable>
			<Host
				matchContents
				seedColor={colors.fg}
				style={{ width: 40, height: 40 }}
			>
				<Menu
					label={
						<Image
							systemName={sf("ellipsis")}
							size={20}
							color={colors.fg}
							modifiers={[frame({ width: 40, height: 40 })]}
						/>
					}
					modifiers={[accessibilityLabel("Chat actions")]}
				>
					{onPin !== undefined ? (
						<NativeButton
							label={isPinned ? "Unpin" : "Pin"}
							systemImage={sf(isPinned ? "pin.slash" : "pin")}
							onPress={onPin}
						/>
					) : null}
					{onRenameChat !== undefined ? (
						<NativeButton
							label="Rename chat"
							systemImage={sf("pencil")}
							onPress={onRenameChat}
						/>
					) : null}
					{onRenameSession !== undefined ? (
						<NativeButton
							label="Rename session"
							systemImage={sf("rectangle.and.pencil.and.ellipsis")}
							onPress={onRenameSession}
						/>
					) : null}
					{onRenameBranch !== undefined ? (
						<NativeButton
							label="Rename branch"
							systemImage={sf("arrow.triangle.branch")}
							onPress={onRenameBranch}
						/>
					) : null}
					<NativeButton
						label="Threads"
						systemImage={sf("rectangle.stack")}
						onPress={onThreads}
					/>
					<NativeButton
						label="Changes"
						systemImage={sf("arrow.triangle.branch")}
						onPress={onChanges}
					/>
					<NativeButton
						label="Files"
						systemImage={sf("folder")}
						onPress={onFiles}
					/>
					{/* biome-ignore lint/a11y/useValidAriaRole: SwiftUI maps this to UIMenu destructive styling. */}
					<NativeButton
						label="Archive"
						systemImage={sf("archivebox")}
						role="destructive"
						onPress={onArchive}
					/>
				</Menu>
			</Host>
		</View>
	);
}
