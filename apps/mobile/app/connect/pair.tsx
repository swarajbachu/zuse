import * as Linking from "expo-linking";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Link2 } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";

import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/empty-state";
import { returnToInbox } from "~/lib/connection-navigation";
import { successTap } from "~/lib/haptics";
import { pairWithDesktop } from "~/lib/pairing";
import { useConnectionsStore } from "~/store/connections";

export default function PairDeepLinkScreen() {
	const url = Linking.useURL();
	const { pairing } = useLocalSearchParams<{ pairing?: string | string[] }>();
	const pairingUrl = Array.isArray(pairing) ? pairing[0] : pairing;
	const candidate = pairingUrl ?? url;
	const add = useConnectionsStore((state) => state.add);
	const started = useRef<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (
			candidate === null ||
			candidate === undefined ||
			started.current === candidate
		)
			return;
		started.current = candidate;
		setError(null);
		void pairWithDesktop(candidate, add)
			.then(() => {
				successTap();
				returnToInbox(router);
			})
			.catch((cause) => {
				setError(
					cause instanceof Error
						? cause.message
						: "That pairing code could not be used.",
				);
			});
	}, [add, candidate]);

	return (
		<View className="flex-1 bg-background px-4">
			<Stack.Screen options={{ title: "Pair with desktop" }} />
			{error === null ? (
				<View className="flex-1 items-center justify-center gap-4">
					<ActivityIndicator />
					<Text className="font-sans text-sm text-muted-foreground">
						Pairing with your desktop…
					</Text>
				</View>
			) : (
				<View className="flex-1 justify-center gap-6">
					<EmptyState icon={Link2} title="Could not pair" detail={error} />
					<Button
						variant="secondary"
						onPress={() => router.replace("/connect/scan")}
					>
						Scan another code
					</Button>
				</View>
			)}
		</View>
	);
}
