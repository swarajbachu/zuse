import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { QrCode, X } from "lucide-react-native";
import { useState } from "react";
import {
	ActivityIndicator,
	Linking,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/empty-state";
import { returnToInbox } from "~/lib/connection-navigation";
import { successTap } from "~/lib/haptics";
import { pairWithDesktop } from "~/lib/pairing";
import { useConnectionsStore } from "~/store/connections";
import { colors } from "~/theme";

export default function ScanScreen() {
	const insets = useSafeAreaInsets();
	const [permission, requestPermission] = useCameraPermissions();
	const [scanned, setScanned] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const add = useConnectionsStore((state) => state.add);

	if (permission === null) {
		return (
			<View className="flex-1 items-center justify-center bg-background">
				<ActivityIndicator />
			</View>
		);
	}

	if (!permission.granted) {
		return (
			<View className="flex-1 bg-background px-4">
				<ScannerCloseButton top={insets.top + 8} />
				<EmptyState
					icon={QrCode}
					title="Camera permission required"
					detail="Camera access is used only to scan a pairing code shown by the desktop app."
				/>
				<View style={{ paddingBottom: insets.bottom + 16 }}>
					<Button
						onPress={
							permission.canAskAgain ? requestPermission : Linking.openSettings
						}
					>
						{permission.canAskAgain ? "Allow camera" : "Open iPhone Settings"}
					</Button>
				</View>
			</View>
		);
	}

	return (
		<View style={{ flex: 1, backgroundColor: "#000000" }}>
			<ScannerCloseButton top={insets.top + 8} />
			<CameraView
				active
				facing="back"
				style={StyleSheet.absoluteFill}
				barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
				onBarcodeScanned={
					scanned
						? undefined
						: async ({ data }) => {
								setScanned(true);
								setError(null);
								try {
									await pairWithDesktop(data, add);
									successTap();
									returnToInbox(router);
								} catch (cause) {
									setError(
										cause instanceof Error
											? cause.message
											: "That pairing code could not be used.",
									);
								}
							}
				}
			/>
			<View
				pointerEvents="none"
				style={StyleSheet.absoluteFill}
				className="items-center justify-center px-10"
			>
				<View
					className="aspect-square w-full rounded-[28px] border-2 border-primary"
					style={{ borderCurve: "continuous" }}
				/>
			</View>
			<View
				className="absolute inset-x-0 bottom-0 px-4 pt-10"
				style={{
					paddingBottom: insets.bottom + 16,
					backgroundColor: "rgba(0,0,0,0.58)",
				}}
			>
				<Text className="text-center font-sans text-sm text-white">
					{scanned
						? "Connecting to your desktop…"
						: "Point your camera at the pairing code."}
				</Text>
				{scanned && error === null ? (
					<ActivityIndicator className="pt-3" color={colors.accent} />
				) : null}
				{error !== null ? (
					<Text
						selectable
						className="pt-2 text-center font-sans text-sm text-danger"
					>
						{error}
					</Text>
				) : null}
				{error !== null ? (
					<View className="pt-3">
						<Button
							onPress={() => {
								setError(null);
								setScanned(false);
							}}
						>
							Try again
						</Button>
					</View>
				) : null}
			</View>
		</View>
	);
}

const ScannerCloseButton = ({ top }: { top: number }) => (
	<Pressable
		accessibilityRole="button"
		accessibilityLabel="Close scanner"
		onPress={() => router.back()}
		style={{
			position: "absolute",
			top,
			left: 16,
			zIndex: 2,
			width: 44,
			height: 44,
			borderRadius: 22,
			alignItems: "center",
			justifyContent: "center",
			backgroundColor: "rgba(0,0,0,0.58)",
		}}
	>
		<X size={21} color={colors.accent} />
	</Pressable>
);
