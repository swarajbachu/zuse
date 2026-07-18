import { AlertTriangle, QrCode, RefreshCw } from "lucide-react-native";
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
			className="rounded-2xl border border-danger/35 bg-danger/10 px-3 py-3"
			style={{ borderCurve: "continuous" }}
		>
			<View className="flex-row items-start gap-2.5">
				<AlertTriangle size={17} color={colors.danger} />
				<Text
					selectable
					className="min-w-0 flex-1 font-sans text-[13px] leading-5 text-danger"
				>
					{message}
				</Text>
			</View>
			<View className="mt-2 flex-row justify-end gap-2">
				{onPairAgain === undefined ? null : (
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Scan a new pairing code"
						onPress={onPairAgain}
						className="min-h-11 flex-row items-center gap-1.5 rounded-xl px-3 active:bg-danger/10"
						style={{ borderCurve: "continuous" }}
					>
						<QrCode size={15} color={colors.secondaryFg} />
						<Text className="font-sans-medium text-[13px] text-muted-foreground">
							Update connection
						</Text>
					</Pressable>
				)}
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="Retry connection"
					onPress={onRetry}
					className="min-h-11 flex-row items-center gap-1.5 rounded-xl bg-primary px-3 active:opacity-70"
					style={{ borderCurve: "continuous" }}
				>
					<RefreshCw size={15} color={colors.primaryForeground} />
					<Text className="font-sans-medium text-[13px] text-primary-foreground">
						Retry
					</Text>
				</Pressable>
			</View>
		</View>
	);
}
