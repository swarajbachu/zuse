import { Alert, Linking } from "react-native";

type Permission = { granted: boolean; canAskAgain: boolean };

export const requestFeaturePermission = async (
	request: () => Promise<Permission>,
	feature: "camera" | "microphone",
): Promise<boolean> => {
	const permission = await request();
	if (permission.granted) return true;
	Alert.alert(
		feature === "camera" ? "Camera access is off" : "Microphone access is off",
		feature === "camera"
			? "You can choose an existing image instead. To take a photo, change camera access in Settings."
			: "You can type your message instead. To dictate, change microphone access in Settings.",
		[
			{ text: "Cancel", style: "cancel" },
			{
				text: "Open Settings",
				onPress: () => {
					void Linking.openSettings().catch(() =>
						Alert.alert(
							"Open device Settings",
							"Select Zuse and update its permissions.",
						),
					);
				},
			},
		],
	);
	return false;
};
