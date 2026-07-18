import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { QrCode } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, Linking, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/empty-state";
import { returnToInbox } from "~/lib/connection-navigation";
import { successTap } from "~/lib/haptics";
import { pairWithDesktop } from "~/lib/pairing";
import { useConnectionsStore } from "~/store/connections";

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
		<View className="flex-1 bg-background">
			<CameraView
				className="flex-1"
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
									setScanned(false);
								}
							}
				}
			/>
			<View
				className="border-t border-border bg-background px-4 pt-4"
				style={{ paddingBottom: insets.bottom + 16 }}
			>
				<Text className="text-center font-sans text-sm text-muted-foreground">
					Scan a zuse:// pairing QR code.
				</Text>
				{error !== null ? (
					<Text
						selectable
						className="pt-2 text-center font-sans text-sm text-danger"
					>
						{error}
					</Text>
				) : null}
			</View>
		</View>
	);
}
