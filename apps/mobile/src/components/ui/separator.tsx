import { View } from "react-native";

import { cn } from "~/lib/cn";

export const Separator = ({ className }: { className?: string }) => (
  <View className={cn("h-px bg-border", className)} />
);
