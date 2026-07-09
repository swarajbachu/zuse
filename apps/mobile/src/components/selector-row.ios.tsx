import { Host } from "@expo/ui";
import { Button as NativeButton, Menu } from "@expo/ui/swift-ui";
import type { ReactNode } from "react";
import { ChevronsUpDown } from "lucide-react-native";
import { View } from "react-native";

export type SelectorOption = {
  key: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
};

/**
 * A transparent (no pill chrome) new-chat selector row: a muted leading icon, a
 * native @expo/ui Menu-wrapped label, and a trailing up/down chevron. Tapping
 * the label opens the native menu of options.
 */
export function SelectorRow({
  leading,
  label,
  options,
  disabled = false,
  emptyLabel = "None",
}: {
  leading: ReactNode;
  label: string;
  options: readonly SelectorOption[];
  disabled?: boolean;
  emptyLabel?: string;
}) {
  return (
    <View className="flex-row items-center gap-2 py-2">
      {leading}
      <View className="min-w-0 flex-1">
        <Host matchContents seedColor="hsl(72 98% 54%)" colorScheme="dark">
          <Menu label={label}>
            {disabled || options.length === 0 ? (
              <NativeButton label={emptyLabel} onPress={() => {}} />
            ) : (
              options.map((option) => (
                <NativeButton
                  key={option.key}
                  label={option.label}
                  systemImage={option.selected ? sf("checkmark") : undefined}
                  onPress={option.onSelect}
                />
              ))
            )}
          </Menu>
        </Host>
      </View>
      <ChevronsUpDown size={12} color="hsl(72 2% 64%)" />
    </View>
  );
}

const sf = (name: string) => name as never;
