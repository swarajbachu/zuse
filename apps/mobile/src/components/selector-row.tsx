import { ChevronsUpDown } from "lucide-react-native";
import { Text, View } from "react-native";

export type SelectorOption = {
  key: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
};

/**
 * Non-iOS stub of the selector row: renders the current label + chevron without
 * the native menu (this app is iOS-first).
 */
export function SelectorRow({
  label,
}: {
  symbol: string;
  label: string;
  options: readonly SelectorOption[];
  disabled?: boolean;
  emptyLabel?: string;
}) {
  return (
    <View className="h-10 flex-row items-center gap-2">
      <Text
        className="font-sans-medium text-[15px] text-foreground"
        numberOfLines={1}
      >
        {label}
      </Text>
      <ChevronsUpDown size={11} color="#c9c9c7" />
    </View>
  );
}
