import type { Chat, Session, SessionStatus } from "@zuse/contracts";
import { ChevronRight } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";

import { cn } from "~/lib/cn";
import { lightTap } from "~/lib/haptics";
import { colors } from "~/theme";
import { StatusDot } from "./ui/status-dot";

/**
 * A session row styled to sit inside an iOS grouped list (`ListSection`) — no
 * card chrome of its own; the section provides the container and separators.
 */
export const SessionRow = ({
	session,
	chat,
	status,
	unread,
	onPress,
}: {
	session: Session;
	chat?: Chat;
	status?: SessionStatus;
	unread: boolean;
	onPress: () => void;
}) => (
	<Pressable
		className="min-h-[54px] flex-row items-center gap-3 px-4 py-2.5 active:bg-card-elevated"
		onPress={() => {
			lightTap();
			onPress();
		}}
	>
		<StatusDot status={status ?? session.status} />
		<View className="min-w-0 flex-1">
			<Text
				className={cn(
					"font-sans-medium text-[15px]",
					unread ? "text-foreground" : "text-muted-foreground",
				)}
				numberOfLines={1}
			>
				{chat?.title ?? session.title}
			</Text>
			<Text
				className="mt-0.5 font-sans text-[12px] text-muted-foreground"
				numberOfLines={1}
			>
				{session.providerId} / {session.model} · {status ?? session.status}
			</Text>
		</View>
		<ChevronRight size={18} color={colors.tertiaryFg} />
	</Pressable>
);
