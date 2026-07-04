import type { Chat, Session, SessionStatus } from "@zuse/wire";
import { Pressable, Text, View } from "react-native";
import { ChevronRight } from "lucide-react-native";

import { cn } from "~/lib/cn";
import { StatusDot } from "./ui/status-dot";
import { UnreadBadge } from "./unread-badge";

export const SessionRow = ({
  session,
  chat,
  status,
  unread,
  onPress
}: {
  session: Session;
  chat?: Chat;
  status?: SessionStatus;
  unread: boolean;
  onPress: () => void;
}) => (
  <Pressable
    className="rounded-lg border border-border bg-card p-3 active:bg-card-elevated"
    onPress={onPress}
  >
    <View className="flex-row items-start gap-3">
      <StatusDot status={status ?? session.status} className="mt-1.5" />
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-2">
          <Text className="min-w-0 flex-1 font-sans-medium text-base text-foreground" numberOfLines={1}>
            {chat?.title ?? session.title}
          </Text>
          <UnreadBadge visible={unread} />
        </View>
        <Text className="mt-1 font-sans text-xs text-muted-foreground" numberOfLines={1}>
          {session.providerId} / {session.model}
        </Text>
        <Text
          className={cn(
            "mt-2 self-start rounded-full border border-border px-2 py-0.5 font-sans text-[11px]",
            status === "running" ? "text-primary" : "text-muted-foreground"
          )}
        >
          {status ?? session.status}
        </Text>
      </View>
      <ChevronRight size={17} color="hsl(72 2% 64%)" />
    </View>
  </Pressable>
);
