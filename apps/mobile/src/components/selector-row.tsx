import type { ReactNode } from "react";
import { ChevronsUpDown } from "lucide-react-native";
import { Text, View } from "react-native";

export type SelectorOption = {
  key: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
};

/**
 * Non-iOS stub of the selector row: renders the icon + current label + chevron
 * without the native menu (this app is iOS-first).
 */
export function SelectorRow({
  leading,
  label,
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
      <Text
        className="min-w-0 flex-1 font-sans-medium text-[15px] text-foreground"
        numberOfLines={1}
      >
        {label}
      </Text>
      <ChevronsUpDown size={12} color="hsl(72 2% 64%)" />
    </View>
  );
}
