import { View, type ViewProps } from "react-native";

import { cn } from "~/lib/cn";

export const Card = ({ className, ...props }: ViewProps) => (
  <View
    className={cn("rounded-lg border border-border bg-card p-4", className)}
    {...props}
  />
);
