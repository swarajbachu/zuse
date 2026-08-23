import { QrCode } from "lucide-react-native";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { colors } from "~/theme";

export function ConnectionRecoveryBanner({
	message,
	onRetry,
	onPairAgain,
	recovering = false,
}: {
	message: string;
	onRetry: () => void;
	onPairAgain?: () => void;
	recovering?: boolean;
}) {
	return (
		<View
			accessibilityRole="alert"
			className="min-h-12 flex-row items-center gap-2 px-2"
		>
			<View className="h-6 w-6 items-center justify-center rounded-full bg-muted">
				{recovering ? (
					<ActivityIndicator size={12} color={colors.accent} />
				) : (
					<View className="h-2 w-2 rounded-full bg-warning" />
				)}
			</View>
			<View className="min-w-0 flex-1 flex-row items-baseline gap-1.5">
				<Text className="font-sans-medium text-[13px] text-foreground">
					{recovering ? "Reconnecting" : "Offline"}
				</Text>
				<Text
					numberOfLines={1}
					className="min-w-0 flex-1 font-sans text-[12px] text-muted-foreground"
				>
					{message}
				</Text>
			</View>
			{recovering || onPairAgain === undefined ? null : (
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Scan a new pairing code"
						onPress={onPairAgain}
					className="h-11 w-11 items-center justify-center rounded-full active:bg-secondary"
						style={{ borderCurve: "continuous" }}
					>
					<QrCode size={17} color={colors.secondaryFg} />
					</Pressable>
				)}
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="Retry connection"
					onPress={onRetry}
				className="h-11 justify-center px-2 active:opacity-60"
				>
				<Text className="font-sans-medium text-[13px] text-primary">Retry</Text>
				</Pressable>
		</View>
	);
}
