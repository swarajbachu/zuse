import { useAtomValue } from "@effect/atom-react";
import { router, Stack } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	Linking,
	ScrollView,
	Switch,
	Text,
	View,
} from "react-native";

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
	analyticsEnabledAtom,
	analyticsHydratedAtom,
	hydrateAnalytics,
	setAnalyticsEnabled,
} from "~/store/analytics";
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
	const analyticsEnabled = useAtomValue(analyticsEnabledAtom);
	const analyticsReady = useAtomValue(analyticsHydratedAtom);
	const [privacyBusy, setPrivacyBusy] = useState(false);
	useEffect(() => {
		void hydrateAnalytics();
	}, []);
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
		() => connections.filter((connection) => connection.source !== "api"),
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
						symbol="qrcode.viewfinder"
						title="Connect to a nearby Mac"
						subtitle="Find it automatically over Wi-Fi"
						onPress={() => router.push("/connect/nearby")}
					/>
					<ListRow
						analyticsId="connections.manual.open"
						symbol="plus"
						iconTone="neutral"
						title="Add manually"
						onPress={() => router.push("/connect/manual")}
					/>
					{directConnections.map((connection) => (
						<ListRow
							key={connection.key}
							symbol="desktopcomputer"
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
					footer="Sign in to access your cloud chats and account-linked computers."
				>
					{account === null ? (
						<ListRow
							symbol="person.crop.circle.fill"
							title="Sign in for remote access"
							subtitle="Optional — local pairing works without this"
							onPress={() => void signIn()}
							disabled={busy}
						/>
					) : (
						<>
							<ListRow
								symbol="person.crop.circle.fill"
								title="Signed in"
								subtitle={account.email ?? account.id}
								chevron={false}
							/>
							<ListRow
								symbol="key.fill"
								title="Cloud Authentication"
								subtitle="Shared across your cloud chats"
								onPress={() => router.push("/cloud-auth")}
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
										connection.source === "api" &&
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
										symbol="desktopcomputer"
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
								symbol="rectangle.portrait.and.arrow.right"
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
							symbol="bell.badge.fill"
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
						symbol="archivebox.fill"
						title="Archived chats"
						subtitle="Preview, restore, or permanently delete"
						onPress={() => router.push("/archives")}
					/>
				</ListSection>

				<ListSection header="Help">
					<ListRow
						symbol="envelope"
						title="Contact support"
						subtitle="hi@zuse.sh"
						onPress={() => {
							void Linking.openURL("mailto:hi@zuse.sh").catch(() =>
								Alert.alert(
									"Contact support",
									"Email hi@zuse.sh for private support and privacy requests.",
								),
							);
						}}
					/>
					<ListRow
						symbol="sparkles"
						title="Getting started"
						subtitle="Review setup and connection options"
						onPress={() =>
							router.push({ pathname: "/onboarding", params: { replay: "1" } })
						}
					/>
				</ListSection>

				<ListSection
					header="Storage"
					footer="Downloaded data can be fetched again. Reset app also removes connections, account state, and unsent messages from this phone."
				>
					<ListRow
						analyticsId="storage.clear-downloads"
						symbol="internaldrive.fill"
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
						symbol="photo.stack.fill"
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
						symbol="arrow.counterclockwise"
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
							symbol="trash.fill"
							iconTone="neutral"
							title={busy ? "Account action in progress…" : "Delete account"}
							subtitle="Permanently delete your account and cloud data"
							destructive
							disabled={busy}
							onPress={() =>
								Alert.alert(
									"Delete account?",
									"This requests permanent deletion of your Zuse account, cloud workspaces and chats, linked-device registrations, and data saved by this app. Cloud cleanup may take time. Files on your own computer are not deleted. This cannot be undone.",
									[
										{ text: "Cancel", style: "cancel" },
										{
											text: "Delete account",
											style: "destructive",
											onPress: () =>
												void deleteAccount()
													.then((result) => {
														Alert.alert(
															result.cleanupPending
																? "Deletion requested"
																: "Account deleted",
															result.localCleanupFailed
																? "Your deletion request was accepted, but some data on this phone could not be cleared. Restart the app and use Reset app in Settings to retry local cleanup."
																: result.cleanupPending
																	? "Your deletion request was accepted. Cloud resources are still being cleaned up. You have been signed out on this phone."
																	: "Your account has been deleted and you have been signed out.",
														);
														returnToInbox(router);
													})
													.catch((cause: unknown) => {
														Alert.alert(
															"Could not delete account",
															cause instanceof Error
																? cause.message
																: "Please try again.",
														);
													}),
										},
									],
								)
							}
						/>
					</ListSection>
				)}
				<ListSection
					header="Privacy"
					footer="Optional: share app activity and sanitized reliability events with PostHog to improve Zuse. Prompts, code, files and recordings are excluded. Turning this off discards pending mobile events."
				>
					<ListRow
						title="Share usage analytics"
						chevron={false}
						trailing={
							<Switch
								accessibilityLabel="Share usage analytics"
								value={analyticsEnabled}
								disabled={!analyticsReady || privacyBusy}
								onValueChange={(next) => {
									setPrivacyBusy(true);
									void setAnalyticsEnabled(next)
										.catch(() =>
											Alert.alert(
												"Could not save privacy preference",
												"Please try again. Analytics remain off if you turned them off.",
											),
										)
										.finally(() => setPrivacyBusy(false));
								}}
							/>
						}
					/>
				</ListSection>
				<ListSection header="About">
					<ListRow
						symbol="hand.raised.fill"
						iconTone="neutral"
						title="Privacy Policy"
						onPress={() => {
							void Linking.openURL("https://zuse.sh/privacy").catch(() => {
								Alert.alert(
									"Could not open Privacy Policy",
									"Visit https://zuse.sh/privacy in your browser.",
								);
							});
						}}
					/>
				</ListSection>
			</ScrollView>
		</>
	);
}
