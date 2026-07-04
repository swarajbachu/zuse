import { Text, View } from "react-native";

import { cn } from "~/lib/cn";

export const Badge = ({
  children,
  tone = "default",
  className
}: {
  children: React.ReactNode;
  tone?: "default" | "primary" | "danger" | "warning";
  className?: string;
}) => (
  <View
    className={cn(
      "rounded-full border px-2 py-0.5",
      tone === "default" && "border-border bg-muted",
      tone === "primary" && "border-primary bg-primary",
      tone === "danger" && "border-danger bg-danger/20",
      tone === "warning" && "border-warning bg-warning/20",
      className
    )}
  >
    <Text
      className={cn(
        "font-sans-medium text-[10px]",
        tone === "primary" ? "text-primary-foreground" : "text-foreground"
      )}
    >
      {children}
    </Text>
  </View>
);
