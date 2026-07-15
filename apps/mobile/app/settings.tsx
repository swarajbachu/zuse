import { router, Stack } from "expo-router";
import {
	Bell,
	ChevronDown,
	ChevronRight,
	LogOut,
	Monitor,
	Plus,
	QrCode,
	Server,
	Trash2,
	UserRound,
} from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	Pressable,
	ScrollView,
	Text,
	View,
} from "react-native";

import { EmptyState } from "~/components/ui/empty-state";
import { ListRow, ListSection } from "~/components/ui/list";
import { visibleConnectionLabel } from "~/lib/display-names";
import { successTap } from "~/lib/haptics";
import { advancedConnections } from "~/lib/settings-connections";
import { registerCurrentDeviceForPush } from "~/notifications/push";
import { useAuthStore } from "~/store/auth";
import {
	connectionStatusLabel,
	useConnectionRuntimeStore,
} from "~/store/connection-runtime";
import { useConnectionsStore } from "~/store/connections";
import { useEnvironmentsStore } from "~/store/environments";
import { colors } from "~/theme";

export default function SettingsScreen() {
	const {
		account,
		hydrated,
		busy,
		error: authError,
		hydrate,
		signIn,
		signOut,
		deleteAccount,
	} = useAuthStore();
	const {
		connections,
		hydrated: connectionsHydrated,
		hydrate: hydrateConnections,
	} = useConnectionsStore();
	const { environments, loading, error, refresh, connect } =
		useEnvironmentsStore();
	const snapshots = useConnectionRuntimeStore(
		(state) => state.snapshotsByConnection,
	);
	const [connecting, setConnecting] = useState<string | null>(null);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [notificationsBusy, setNotificationsBusy] = useState(false);

	useEffect(() => {
		if (!hydrated) void hydrate();
	}, [hydrate, hydrated]);

	useEffect(() => {
		if (!connectionsHydrated) void hydrateConnections();
	}, [connectionsHydrated, hydrateConnections]);

	useEffect(() => {
		if (account !== null) void refresh();
	}, [account, refresh]);

	const manualConnections = useMemo(
		() => advancedConnections(connections),
		[connections],
	);

	const onConnect = async (environmentId: string) => {
		setConnecting(environmentId);
		try {
			const key = await connect(environmentId);
			successTap();
			router.push(`/c/${encodeURIComponent(key)}`);
		} finally {
			setConnecting(null);
		}
	};

	return (
		<>
			<Stack.Screen options={{ title: "Settings" }} />
			<ScrollView
				className="flex-1"
				contentInsetAdjustmentBehavior="automatic"
				contentContainerClassName="gap-6 p-4 pb-12 pt-3"
			>
				<ListSection header="Account">
					{account === null ? (
						<ListRow
							icon={UserRound}
							title="Sign in"
							subtitle="Use the same account as your Mac"
							onPress={() => void signIn()}
							disabled={busy}
						/>
					) : (
						<>
							<ListRow
								icon={UserRound}
								title="Signed in"
								subtitle={account.email ?? account.id}
								chevron={false}
							/>
							<ListRow
								icon={LogOut}
								iconTone="neutral"
								title="Sign out"
								destructive
								onPress={() => void signOut()}
							/>
							<ListRow
								icon={Trash2}
								iconTone="neutral"
								title="Delete account"
								subtitle="Permanently removes your account and linked computers"
								destructive
								disabled={busy}
								onPress={() =>
									Alert.alert(
										"Delete account?",
										"This permanently removes your account, linked computers, device registrations, and cached chats. This cannot be undone.",
										[
											{ text: "Cancel", style: "cancel" },
											{
												text: "Delete account",
												style: "destructive",
												onPress: () => void deleteAccount().catch(() => {}),
											},
										],
									)
								}
							/>
						</>
					)}
				</ListSection>

				{account === null ? null : (
					<ListSection
						header="Notifications"
						footer="Enable alerts when an agent needs approval or has a question."
					>
						<ListRow
							icon={Bell}
							title="Enable notifications"
							subtitle="You can change this later in iPhone Settings"
							disabled={notificationsBusy}
							onPress={async () => {
								setNotificationsBusy(true);
								const enabled = await registerCurrentDeviceForPush(account);
								setNotificationsBusy(false);
								Alert.alert(
									enabled ? "Notifications enabled" : "Notifications are off",
									enabled
										? "We’ll alert you when your attention is needed."
										: "Allow notifications in iPhone Settings to receive agent alerts.",
								);
							}}
						/>
					</ListSection>
				)}

				{authError ? (
					<Text selectable className="px-4 font-sans text-sm text-danger">
						{authError}
					</Text>
				) : null}

				{account === null ? (
					<View className="pt-8">
						<EmptyState
							icon={Monitor}
							title="Sign in to manage computers"
							detail="Account-linked computers are the primary way this app loads projects and chats."
						/>
					</View>
				) : (
					<ListSection
						header="Computers"
						footer="Open the desktop app on a linked computer to make its projects and chats available here."
					>
						{loading ? (
							<View className="min-h-[54px] flex-row items-center gap-3 px-4 py-2.5">
								<ActivityIndicator />
								<Text className="font-sans text-[17px] text-foreground">
									Loading computers
								</Text>
							</View>
						) : null}
						{environments.map((environment) => {
							const saved = connections.find(
								(connection) =>
									connection.environmentId === environment.environmentId,
							);
							const snapshot = saved ? snapshots[saved.key] : undefined;
							const subtitle =
								connecting === environment.environmentId
									? "Connecting..."
									: snapshot !== undefined
										? connectionStatusLabel(snapshot)
										: environment.presence === "online"
											? "Online"
											: environment.presence === "offline"
												? "Offline"
												: "Checking...";
							return (
								<ListRow
									key={environment.environmentId}
									icon={Monitor}
									iconTone={
										environment.presence === "online" ? "brand" : "neutral"
									}
									title={visibleConnectionLabel(environment.label)}
									subtitle={subtitle}
									onPress={() =>
										saved
											? router.push(`/c/${encodeURIComponent(saved.key)}`)
											: void onConnect(environment.environmentId)
									}
								/>
							);
						})}
						{environments.length === 0 && !loading ? (
							<ListRow
								icon={Monitor}
								iconTone="neutral"
								title="No computers found"
								subtitle="Check the desktop app device settings"
								chevron={false}
							/>
						) : null}
						{error ? (
							<View className="px-4 py-3">
								<Text
									selectable
									className="font-sans text-sm leading-5 text-danger"
								>
									{error}
								</Text>
							</View>
						) : null}
					</ListSection>
				)}

				<View className="gap-2">
					<Pressable
						accessibilityRole="button"
						accessibilityState={{ expanded: advancedOpen }}
						className="flex-row items-center gap-2 px-4 active:opacity-70"
						onPress={() => setAdvancedOpen((open) => !open)}
					>
						{advancedOpen ? (
							<ChevronDown size={18} color={colors.tertiaryFg} />
						) : (
							<ChevronRight size={18} color={colors.tertiaryFg} />
						)}
						<Text className="font-sans-medium text-[13px] uppercase tracking-wide text-muted-foreground">
							Advanced connections
						</Text>
					</Pressable>

					{advancedOpen ? (
						<ListSection footer="Manual host and QR pairing are fallback options for local development or direct servers.">
							{manualConnections.map((connection) => (
								<ListRow
									key={connection.key}
									icon={Server}
									iconTone="neutral"
									title={visibleConnectionLabel(
										connection.label,
										"Manual connection",
									)}
									subtitle={`${connection.host}:${connection.port}`}
									onPress={() =>
										router.push(`/c/${encodeURIComponent(connection.key)}`)
									}
								/>
							))}
							<ListRow
								icon={Plus}
								iconTone="neutral"
								title="Add manually"
								onPress={() => router.push("/connect/manual")}
							/>
							<ListRow
								icon={QrCode}
								iconTone="neutral"
								title="Scan QR code"
								onPress={() => router.push("/connect/scan")}
							/>
						</ListSection>
					) : null}
				</View>
			</ScrollView>
		</>
	);
}
