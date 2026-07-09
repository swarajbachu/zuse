import { Host } from "@expo/ui";
import { Button as NativeButton, Menu } from "@expo/ui/swift-ui";

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
    <Host matchContents seedColor="hsl(72 98% 54%)" colorScheme="dark">
      <Menu label="" systemImage="ellipsis">
        {onRename !== undefined ? (
          <NativeButton
            label="Rename chat"
            systemImage="pencil"
            onPress={onRename}
          />
        ) : null}
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
