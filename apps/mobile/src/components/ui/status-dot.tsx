import type { SessionStatus } from "@zuse/wire";
import { View } from "react-native";

import { cn } from "~/lib/cn";

export const StatusDot = ({ status, className }: { status?: SessionStatus; className?: string }) => (
  <View
    className={cn(
      "h-2.5 w-2.5 rounded-full",
      status === "booting" && "bg-warning",
      status === "running" && "bg-primary",
      status === "error" && "bg-danger",
      (status === undefined || status === "idle" || status === "closed") &&
        "bg-muted-foreground",
      className
    )}
  />
);
