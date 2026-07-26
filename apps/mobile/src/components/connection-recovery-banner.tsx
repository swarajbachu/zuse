import { CloudOff, QrCode, RefreshCw } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";

import { colors } from "~/theme";

export function ConnectionRecoveryBanner({
	message,
	onRetry,
	onPairAgain,
}: {
	message: string;
	onRetry: () => void;
	onPairAgain?: () => void;
}) {
	return (
		<View
			accessibilityRole="alert"
			className="rounded-2xl border border-border bg-card px-3 py-2.5"
			style={{ borderCurve: "continuous" }}
		>
			<View className="flex-row items-center gap-2">
				<View className="h-8 w-8 items-center justify-center rounded-full bg-warning/15">
					<CloudOff size={16} color={colors.warning} />
				</View>
				<View className="min-w-0 flex-1">
					<Text className="font-sans-medium text-[13px] text-foreground">
						Connection paused
					</Text>
					<Text
						numberOfLines={2}
						className="font-sans text-[12px] leading-4 text-muted-foreground"
					>
						{message}
					</Text>
				</View>
				{onPairAgain === undefined ? null : (
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
					className="h-11 flex-row items-center gap-1.5 rounded-xl bg-secondary px-3 active:opacity-70"
					style={{ borderCurve: "continuous" }}
				>
					<RefreshCw size={14} color={colors.fg} />
					<Text className="font-sans-medium text-[13px] text-foreground">
						Retry
					</Text>
				</Pressable>
			</View>
		</View>
	);
}
