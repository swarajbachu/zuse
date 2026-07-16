import { ChevronRight, Server } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";
import type { ConnectionRecord } from "~/store/connections";
import { colors } from "~/theme";

export const ConnectionCard = ({
	connection,
	onPress,
}: {
	connection: ConnectionRecord;
	onPress: () => void;
}) => (
	<Pressable
		className="rounded-lg border border-border bg-card p-4 active:bg-card-elevated"
		onPress={onPress}
	>
		<View className="flex-row items-center gap-3">
			<View className="h-10 w-10 items-center justify-center rounded-lg bg-muted">
				<Server size={18} color={colors.accent} />
			</View>
			<View className="min-w-0 flex-1">
				<Text
					className="font-sans-medium text-base text-foreground"
					numberOfLines={1}
				>
					{connection.label}
				</Text>
				<Text
					className="mt-1 font-sans text-xs text-muted-foreground"
					numberOfLines={1}
				>
					{connection.token ? "Pairing token saved" : "Manual connection"}
				</Text>
			</View>
			<ChevronRight size={18} color={colors.secondaryFg} />
		</View>
	</Pressable>
);
