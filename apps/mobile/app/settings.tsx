import { useAtomValue } from "@effect/atom-react";
import { router, Stack } from "expo-router";
import {
	Archive,
	BarChart3,
	Bell,
	HardDrive,
	Images,
	LogOut,
	Monitor,
	Plus,
	QrCode,
	RotateCcw,
	TerminalSquare,
	Trash2,
	UserRound,
} from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, View } from "react-native";

import { ListRow, ListSection } from "~/components/ui/list";
import { captureMobileAnalytics } from "~/lib/analytics";
import { returnToInbox } from "~/lib/connection-navigation";
import { visibleConnectionLabel } from "~/lib/display-names";
import { successTap } from "~/lib/haptics";
import { clearMediaCache, mediaCacheSize } from "~/lib/media-cache";
import { clearDownloadedMobileData } from "~/lib/mobile-data";
import { registerCurrentDeviceForPush } from "~/notifications/push";
import { downloadedCacheSize } from "~/offline/cache";
import {
	authAccountAtom,
	authBusyAtom,
	authErrorAtom,
	authHydratedAtom,
	deleteAccount,
	hydrateAuth,
	resetApp,
	signIn,
	signOut,
} from "~/store/auth";
import {
	connectionStatusLabel,
	snapshotsByConnectionAtom,
} from "~/store/connection-runtime";
import {
	connectionsAtom,
	connectionsHydratedAtom,
	hydrateConnections,
} from "~/store/connections";
import {
	connectToEnvironment,
	environmentsAtom,
	environmentsErrorAtom,
	environmentsLoadingAtom,
	refreshEnvironments,
} from "~/store/environments";

const formatBytes = (bytes: number | null): string => {
	if (bytes === null) return "Calculating…";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export default function SettingsScreen() {
	const account = useAtomValue(authAccountAtom);
	const hydrated = useAtomValue(authHydratedAtom);
	const busy = useAtomValue(authBusyAtom);
	const authError = useAtomValue(authErrorAtom);
	const connections = useAtomValue(connectionsAtom);
	const connectionsHydrated = useAtomValue(connectionsHydratedAtom);
	const environments = useAtomValue(environmentsAtom);
	const loading = useAtomValue(environmentsLoadingAtom);
	const error = useAtomValue(environmentsErrorAtom);
	const snapshots = useAtomValue(snapshotsByConnectionAtom);
	const [connecting, setConnecting] = useState<string | null>(null);
	const [notificationsBusy, setNotificationsBusy] = useState(false);
	const [storageBusy, setStorageBusy] = useState(false);
	const [downloadedBytes, setDownloadedBytes] = useState<number | null>(null);
	const [mediaBytes, setMediaBytes] = useState<number | null>(null);

	useEffect(() => {
		if (!hydrated) void hydrateAuth();
	}, [hydrated]);

	useEffect(() => {
		if (!connectionsHydrated) void hydrateConnections();
	}, [connectionsHydrated]);

	useEffect(() => {
		if (account !== null) void refreshEnvironments();
	}, [account]);

	useEffect(() => {
		void downloadedCacheSize()
			.then(setDownloadedBytes)
			.catch(() => setDownloadedBytes(0));
		void mediaCacheSize()
			.then(setMediaBytes)
			.catch(() => setMediaBytes(0));
	}, []);

	const directConnections = useMemo(
		() => connections.filter((connection) => connection.source !== "relay"),
		[connections],
	);

	const onConnect = async (environmentId: string) => {
		setConnecting(environmentId);
		const startedAt = Date.now();
		captureMobileAnalytics("connection attempted", {
			connection_kind: "remote",
		});
		try {
			await connectToEnvironment(environmentId);
			captureMobileAnalytics("connection established", {
				connection_kind: "remote",
				duration_ms: Date.now() - startedAt,
			});
			successTap();
			returnToInbox(router);
		} catch (cause) {
			captureMobileAnalytics("connection failed", {
				connection_kind: "remote",
				duration_ms: Date.now() - startedAt,
				error_code: "connect_failed",
			});
			throw cause;
		} finally {
			setConnecting(null);
		}
	};

	const clearDownloaded = async () => {
		setStorageBusy(true);
		try {
			await clearDownloadedMobileData();
			setDownloadedBytes(0);
			successTap();
			returnToInbox(router);
		} finally {
			setStorageBusy(false);
		}
	};

	const clearMedia = async () => {
		setStorageBusy(true);
		try {
			await clearMediaCache();
			setMediaBytes(0);
			successTap();
		} finally {
			setStorageBusy(false);
		}
	};

	return (
		<>
			<Stack.Screen
				options={{
					title: "Settings",
					headerBackVisible: false,
					headerTransparent: true,
				}}
			/>
			<Stack.Toolbar placement="right">
				<Stack.Toolbar.Button
					icon="xmark"
					separateBackground
					onPress={() => router.back()}
				/>
			</Stack.Toolbar>
			<ScrollView
				className="flex-1"
				contentInsetAdjustmentBehavior="automatic"
				showsVerticalScrollIndicator={false}
				contentContainerClassName="gap-6 px-5 pb-12 pt-4"
			>
				<ListSection
					header="Connections"
					footer="Pairing works directly over your local network and does not require an account."
				>
					<ListRow
						analyticsId="connections.nearby.open"
						icon={QrCode}
						title="Connect to a nearby Mac"
						subtitle="Find it automatically over Wi-Fi"
						onPress={() => router.push("/connect/nearby")}
					/>
					<ListRow
						analyticsId="connections.manual.open"
						icon={Plus}
						iconTone="neutral"
						title="Add manually"
						onPress={() => router.push("/connect/manual")}
					/>
					{directConnections.map((connection) => (
						<ListRow
							key={connection.key}
							icon={Monitor}
							iconTone="neutral"
							title={visibleConnectionLabel(connection.label, "Computer")}
							subtitle={
								snapshots[connection.key] === undefined
									? `${connection.host}:${connection.port}`
									: connectionStatusLabel(snapshots[connection.key])
							}
							chevron={false}
						/>
					))}
				</ListSection>

				<ListSection
					header="Remote access"
					footer="Sign in only when you want to reach account-linked computers away from your local network."
				>
					{account === null ? (
						<ListRow
							icon={UserRound}
							title="Sign in for remote access"
							subtitle="Optional — local pairing works without this"
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
							{loading ? (
								<View className="min-h-[54px] flex-row items-center gap-3 px-4 py-2.5">
									<ActivityIndicator />
									<Text className="font-sans text-[17px] text-foreground">
										Loading remote computers
									</Text>
								</View>
							) : null}
							{environments.map((environment) => {
								const saved = connections.find(
									(connection) =>
										connection.source === "relay" &&
										connection.environmentId === environment.environmentId,
								);
								const snapshot = saved ? snapshots[saved.key] : undefined;
								const subtitle =
									connecting === environment.environmentId
										? "Connecting…"
										: snapshot !== undefined
											? connectionStatusLabel(snapshot)
											: environment.presence === "online"
												? "Online"
												: environment.presence === "offline"
													? "Offline"
													: "Checking…";
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
												? returnToInbox(router)
												: void onConnect(environment.environmentId)
										}
									/>
								);
							})}
							<ListRow
								icon={LogOut}
								iconTone="neutral"
								title="Sign out"
								destructive
								onPress={() => void signOut()}
							/>
						</>
					)}
					{authError ? (
						<View className="px-4 py-3">
							<Text
								selectable
								className="font-sans text-sm leading-5 text-danger"
							>
								{authError}
							</Text>
						</View>
					) : null}
					{account !== null && error ? (
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

				{account === null ? null : (
					<ListSection header="Notifications">
						<ListRow
							icon={Bell}
							title="Enable notifications"
							subtitle="Alerts for approvals and questions"
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

				<ListSection
					header="Developer workflow"
					footer="These tools use the already paired computer and its authenticated environment."
				>
					<ListRow
						icon={TerminalSquare}
						title="Terminals and voice"
						subtitle="Live sessions and account readiness"
						onPress={() => router.push("/developer-tools")}
					/>
					<ListRow
						icon={Archive}
						title="Archived chats"
						subtitle="Preview, restore, or permanently delete"
						onPress={() => router.push("/archives")}
					/>
					<ListRow
						icon={BarChart3}
						title="Usage"
						subtitle="Tokens, cost, and provider limits"
						onPress={() => router.push("/usage")}
					/>
				</ListSection>

				<ListSection
					header="Storage"
					footer="Downloaded data can be fetched again. Reset app also removes connections, account state, and unsent messages from this phone."
				>
					<ListRow
						analyticsId="storage.clear-downloads"
						icon={HardDrive}
						iconTone="neutral"
						title="Clear downloaded data"
						value={formatBytes(downloadedBytes)}
						disabled={storageBusy}
						onPress={() =>
							Alert.alert(
								"Clear downloaded data?",
								"Cached projects, chats, and messages will be removed. Connections and unsent messages will be kept.",
								[
									{ text: "Cancel", style: "cancel" },
									{ text: "Clear", onPress: () => void clearDownloaded() },
								],
							)
						}
					/>
					<ListRow
						analyticsId="storage.clear-media"
						icon={Images}
						iconTone="neutral"
						title="Clear media cache"
						subtitle="Images and document previews"
						value={formatBytes(mediaBytes)}
						disabled={storageBusy}
						onPress={() =>
							Alert.alert(
								"Clear media cache?",
								"Fetched images and document previews will be removed and downloaded again when needed.",
								[
									{ text: "Cancel", style: "cancel" },
									{ text: "Clear", onPress: () => void clearMedia() },
								],
							)
						}
					/>
					<ListRow
						analyticsId="account.reset-app"
						icon={RotateCcw}
						iconTone="neutral"
						title="Reset app"
						subtitle="Remove all data stored on this phone"
						destructive
						disabled={busy || storageBusy}
						onPress={() =>
							Alert.alert(
								"Reset this app?",
								"This removes account state, connections, cache, device keys, and unsent messages from this phone. Your remote account is not deleted.",
								[
									{ text: "Cancel", style: "cancel" },
									{
										text: "Reset app",
										style: "destructive",
										onPress: () =>
											void resetApp()
												.then(() => returnToInbox(router))
												.catch(() => {}),
									},
								],
							)
						}
					/>
				</ListSection>

				{account === null ? null : (
					<ListSection header="Account">
						<ListRow
							analyticsId="account.delete"
							icon={Trash2}
							iconTone="neutral"
							title="Delete account"
							subtitle="Permanently remove your account and linked computers"
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
					</ListSection>
				)}
			</ScrollView>
		</>
	);
}
