import { useAtomValue } from "@effect/atom-react";
import * as Notifications from "expo-notifications";
import { router, Stack } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	AppState,
	Linking,
	ScrollView,
	Switch,
	Text,
	View,
} from "react-native";
import { ListRow, ListSection } from "~/components/ui/list";
import { resetAiSharingConsent } from "~/lib/ai-sharing-consent";
import { captureMobileAnalytics } from "~/lib/analytics";
import { computerRows } from "~/lib/computers";
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

const settingsTitles = {
	home: "Settings",
	account: "Account",
	computers: "Computers",
	privacy: "Privacy",
	storage: "Storage",
	help: "Help",
} as const;

export default function SettingsScreen({
	page,
}: {
	page: keyof typeof settingsTitles;
}) {
	const setPage = (next: keyof typeof settingsTitles) => {
		if (next === "home") router.back();
		else router.push(`/settings/${next}`);
	};
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
	const [notificationsEnabled, setNotificationsEnabled] = useState(false);
	const [notificationsReady, setNotificationsReady] = useState(false);
	useEffect(() => {
		let active = true;
		const refresh = async () => {
			try {
				const permission = await Notifications.getPermissionsAsync();
				if (active) {
					setNotificationsEnabled(permission.granted);
					setNotificationsReady(true);
				}
			} catch {
				if (active) setNotificationsReady(true);
			}
		};
		void refresh();
		const subscription = AppState.addEventListener("change", (state) => {
			if (state === "active") void refresh();
		});
		return () => {
			active = false;
			subscription.remove();
		};
	}, []);
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
		if (account !== null && page === "computers") void refreshEnvironments();
	}, [account, page]);

	useEffect(() => {
		if (page !== "storage") return;
		void downloadedCacheSize()
			.then(setDownloadedBytes)
			.catch(() => setDownloadedBytes(0));
		void mediaCacheSize()
			.then(setMediaBytes)
			.catch(() => setMediaBytes(0));
	}, [page]);

	const computers = useMemo(
		() => computerRows(connections, environments, account !== null, snapshots),
		[connections, environments, account, snapshots],
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

	const changeNotifications = async (enabled: boolean) => {
		if (!enabled) {
			await Linking.openSettings().catch(() =>
				Alert.alert(
					"Open device Settings",
					"Select Zuse → Notifications to turn alerts off.",
				),
			);
			return;
		}
		if (account === null) {
			Alert.alert(
				"Sign in for notifications",
				"Sign in to receive agent alerts.",
				[
					{ text: "Cancel", style: "cancel" },
					{ text: "Sign in", onPress: () => setPage("account") },
				],
			);
			return;
		}
		setNotificationsBusy(true);
		try {
			const permission = await Notifications.requestPermissionsAsync();
			setNotificationsEnabled(permission.granted);
			if (permission.granted) {
				// Permission controls the switch; token registration runs independently.
				void registerCurrentDeviceForPush(account).catch(() => {
					Alert.alert(
						"Push setup needs attention",
						"Alerts are allowed on this phone, but Zuse could not finish registration. We will retry when you reopen the app.",
					);
				});
			} else {
				Alert.alert(
					"Allow notifications in Settings",
					"Enable notifications for Zuse in device Settings.",
					[
						{ text: "Cancel", style: "cancel" },
						{
							text: "Open Settings",
							onPress: () => {
								void Linking.openSettings();
							},
						},
					],
				);
			}
		} catch {
			Alert.alert(
				"Could not read notification access",
				"Please try again in device Settings.",
			);
		} finally {
			setNotificationsBusy(false);
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
					title: settingsTitles[page],
					headerBackVisible: page !== "home",
					headerTransparent: true,
				}}
			/>
			<Stack.Toolbar placement="right">
				<Stack.Toolbar.Button
					icon="xmark"
					separateBackground
					onPress={() => router.dismissTo("/")}
				/>
			</Stack.Toolbar>
			<ScrollView
				className="flex-1"
				contentInsetAdjustmentBehavior="automatic"
				showsVerticalScrollIndicator={false}
				contentContainerClassName="gap-5 px-5 pb-8 pt-4"
			>
				{page === "home" ? (
					<>
						<ListSection>
							<ListRow
								symbol="person.crop.circle.fill"
								title={account ? "Account" : "Sign in"}
								subtitle={account?.email ?? "Cloud chats and remote access"}
								onPress={() => setPage("account")}
							/>
						</ListSection>
						<ListSection>
							<ListRow
								symbol="bell.badge.fill"
								title="Notifications"
								subtitle={
									notificationsEnabled
										? "Enabled · Manage in device Settings"
										: "Off"
								}
								chevron={false}
								trailing={
									<Switch
										accessibilityLabel="Notifications"
										value={notificationsEnabled}
										disabled={!notificationsReady || notificationsBusy || busy}
										onValueChange={(next) => {
											void changeNotifications(next);
										}}
									/>
								}
							/>
							<ListRow
								symbol="desktopcomputer"
								title="Computers"
								onPress={() => setPage("computers")}
							/>
							<ListRow
								symbol="archivebox.fill"
								title="Archived chats"
								onPress={() => router.push("/archives")}
							/>
						</ListSection>
						<ListSection>
							<ListRow
								symbol="hand.raised.fill"
								title="Privacy"
								onPress={() => setPage("privacy")}
							/>
							<ListRow
								symbol="internaldrive.fill"
								title="Storage"
								onPress={() => setPage("storage")}
							/>
							<ListRow
								symbol="envelope"
								title="Help"
								onPress={() => setPage("help")}
							/>
						</ListSection>
					</>
				) : null}
				{page === "computers" ? (
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
						{computers.map(({ key, connection, environment }) => {
							const snapshot = connection
								? snapshots[connection.key]
								: undefined;
							const connected = snapshot?.status === "connected";
							const canConnect = environment !== undefined && !connected;
							const subtitle =
								connecting !== null && connecting === environment?.environmentId
									? "Connecting…"
									: snapshot
										? connectionStatusLabel(snapshot)
										: environment?.presence === "online"
											? "Online"
											: environment?.presence === "offline"
												? "Offline"
												: "Checking…";
							return (
								<ListRow
									key={key}
									symbol="desktopcomputer"
									iconTone={connected ? "brand" : "neutral"}
									title={visibleConnectionLabel(
										connection?.label ?? environment?.label,
									)}
									subtitle={subtitle}
									chevron={canConnect}
									onPress={
										canConnect
											? () => void onConnect(environment.environmentId)
											: connection
												? () => returnToInbox(router)
												: undefined
									}
								/>
							);
						})}
						{loading ? (
							<View className="min-h-[54px] flex-row items-center gap-3 px-4 py-2.5">
								<ActivityIndicator />
								<Text className="font-sans text-[17px] text-foreground">
									Refreshing computers
								</Text>
							</View>
						) : null}
						{error ? (
							<Text className="px-4 py-3 text-danger">{error}</Text>
						) : null}
					</ListSection>
				) : null}

				{page === "account" ? (
					<ListSection
						header="Remote access"
						footer="Sign in to access your cloud chats and account-linked computers."
					>
						{account === null ? (
							<ListRow
								symbol="person.crop.circle.fill"
								title="Sign in for remote access"
								subtitle="Cloud chats and remote access"
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
					</ListSection>
				) : null}

				{page === "help" ? (
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
								router.push({
									pathname: "/onboarding",
									params: { replay: "1" },
								})
							}
						/>
					</ListSection>
				) : null}

				{page === "storage" ? (
					<ListSection
						header="Storage"
						footer="Downloaded data can be fetched again. Reset app also removes connections, account state, and unsent messages from this device."
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
							subtitle="Remove all data stored on this device"
							destructive
							disabled={busy || storageBusy}
							onPress={() =>
								Alert.alert(
									"Reset this app?",
									"This removes account state, connections, cache, device keys, and unsent messages from this device. Your remote account is not deleted.",
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
				) : null}

				{page !== "account" || account === null ? null : (
					<ListSection>
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
																? "Your deletion request was accepted, but some data on this device could not be cleared. Restart the app and use Reset app in Settings to retry local cleanup."
																: result.cleanupPending
																	? "Your deletion request was accepted. Cloud resources are still being cleaned up. You have been signed out on this device."
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
				{page === "privacy" ? (
					<ListSection
						header="Privacy"
						footer="Optional: share app activity and sanitized reliability events with PostHog to improve Zuse. Prompts, code, files and recordings are excluded. Turning this off discards pending mobile events."
					>
						<ListRow
							title="Reset AI sharing choices"
							subtitle="Ask again before sending to an AI provider"
							onPress={() => {
								resetAiSharingConsent();
								Alert.alert(
									"Sharing choices reset",
									"Zuse will ask before your next message or recording. Data already sent and work already running are not recalled.",
								);
							}}
						/>
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
				) : null}
				{page === "privacy" ? (
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
				) : null}
			</ScrollView>
		</>
	);
}
