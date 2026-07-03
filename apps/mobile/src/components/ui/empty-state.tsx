import { Text, View } from "react-native";
import type { LucideIcon } from "lucide-react-native";

export const EmptyState = ({
  icon: Icon,
  title,
  detail
}: {
  icon: LucideIcon;
  title: string;
  detail?: string;
}) => (
  <View className="flex-1 items-center justify-center gap-3 px-8">
    <View className="h-12 w-12 items-center justify-center rounded-lg border border-border bg-card">
      <Icon size={22} color="hsl(72 98% 54%)" />
    </View>
    <Text className="text-center font-sans-medium text-base text-foreground">{title}</Text>
    {detail !== undefined ? (
      <Text className="text-center font-sans text-sm leading-5 text-muted-foreground">
        {detail}
      </Text>
    ) : null}
  </View>
);
