import { useAtomValue } from "@effect/atom-react";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { type ComponentType, useEffect } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { Button } from "~/components/ui/button";
import {
	normalizeConnParam,
	optionsForConnection,
} from "~/lib/connection-params";
import { authAccountAtom, authHydratedAtom, hydrateAuth } from "~/store/auth";
import {
	cloudCatalogAtom,
	cloudCatalogGeneration,
} from "~/store/cloud-catalog";
import {
	allConnectionsAtom,
	connectionsHydratedAtom,
	hydrateConnections,
} from "~/store/connections";

/** Unmount resource views on access loss; old cached content must not remain visible. */
export function withWorkspaceConnection(Screen: ComponentType) {
	return function WorkspaceConnectionScreen() {
		const params = useLocalSearchParams<{ conn?: string | string[] }>();
		const catalog = useAtomValue(cloudCatalogAtom);
		const account = useAtomValue(authAccountAtom);
		const authReady = useAtomValue(authHydratedAtom);
		const hydrated = useAtomValue(connectionsHydratedAtom);
		const connections = useAtomValue(allConnectionsAtom);
		useEffect(() => {
			if (!hydrated) void hydrateConnections();
		}, [hydrated]);
		useEffect(() => {
			if (!authReady) void hydrateAuth();
		}, [authReady]);
		const connection = optionsForConnection(
			normalizeConnParam(params.conn),
			connections,
		);
		const accountCurrent = catalog.accountId === (account?.id ?? null);
		if (connection !== null && accountCurrent)
			return (
				<Screen key={`${cloudCatalogGeneration()}:${JSON.stringify(params)}`} />
			);
		return (
			<View className="flex-1 gap-4 bg-background p-5">
				<Stack.Screen
					options={{ title: "Workspace", headerLargeTitle: false }}
				/>
				{!hydrated || !authReady || catalog.loading ? (
					<ActivityIndicator />
				) : (
					<Text className="text-muted-foreground">
						This connection is not available in the selected workspace. Open the
						chat from its workspace, or reconnect the computer in Personal.
					</Text>
				)}
				<Button
					className="h-7"
					variant="ghost"
					onPress={() => router.replace("/")}
				>
					Back to chats
				</Button>
			</View>
		);
	};
}
