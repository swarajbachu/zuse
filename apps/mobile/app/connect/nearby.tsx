import * as ExpoCrypto from "expo-crypto";
import { router, Stack } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { Cloud, Monitor, Radio, ShieldCheck } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	Pressable,
	ScrollView,
	Text,
	useWindowDimensions,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/empty-state";
import { returnToInbox } from "~/lib/connection-navigation";
import { deviceLabel, getOrCreateDeviceId } from "~/lib/device-identity";
import { successTap } from "~/lib/haptics";
import { pollNearbyApproval } from "~/lib/nearby-approval";
import {
	nearbyPairingChallenge,
	nearbyPairingStatus,
	serverKeyPin,
	startNearbyPairing,
} from "~/lib/nearby-pairing";
import {
	decryptPairingCredential,
	ephemeralPairingPublicKey,
	pairingDevicePublicKey,
} from "~/lib/pairing-device-key";
import { connectEnvironment } from "~/rpc/relay-client";
import { useAuthStore } from "~/store/auth";
import { useConnectionsStore } from "~/store/connections";
import { colors } from "~/theme";

import {
	closeLocalProxy,
	hasICloudTrustRecord,
	type LocalDiscoveryState,
	type LocalProxy,
	localConnectivityAvailable,
	type NearbyService,
	nearbyMacDisplayName,
	onLocalDiscoveryStateChanged,
	onNearbyServicesChanged,
	openLocalProxy,
	proofForICloudTrustRecord,
	startLocalDiscovery,
} from "../../modules/local-connectivity";

type PendingApproval = {
	readonly requestId: string;
	readonly safetyPhrase: string;
	readonly deviceIdentifier: string;
	readonly environmentPublicKey: string;
	readonly service: NearbyService;
	readonly proxy: LocalProxy;
};

const iCloudTrustLabel = (available: boolean | undefined): string => {
	if (available === true) return "iCloud trust available";
	if (available === false) return "Mac approval required";
	return "Checking iCloud trust…";
};

const safetyPhraseLabel = (phrase: string): string =>
	phrase.split("-").join("  ·  ");

const randomNonce = (): string =>
	Array.from(ExpoCrypto.getRandomBytes(18), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");

export default function NearbyConnectScreen() {
	const headerHeight = useHeaderHeight();
	const insets = useSafeAreaInsets();
	const { height: windowHeight } = useWindowDimensions();
	const add = useConnectionsStore((state) => state.add);
	const [services, setServices] = useState<readonly NearbyService[]>([]);
	const [pending, setPending] = useState<PendingApproval | null>(null);
	const [starting, setStarting] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [showQrFallback, setShowQrFallback] = useState(false);
	const [icloudTrust, setIcloudTrust] = useState<
		Readonly<Record<string, boolean>>
	>({});
	const [discoveryState, setDiscoveryState] = useState<LocalDiscoveryState>({
		state: "starting",
	});
	const startedAutomatically = useRef(false);
	const completed = useRef(false);

	useEffect(() => {
		void startLocalDiscovery();
		const removeServices = onNearbyServicesChanged(setServices);
		const removeDiscoveryState = onLocalDiscoveryStateChanged((next) => {
			setDiscoveryState(next);
			console.info("[zuse:nearby] discovery.state", next);
		});
		return () => {
			removeServices();
			removeDiscoveryState();
		};
	}, []);

	useEffect(() => {
		if (services.length > 0) {
			setShowQrFallback(false);
			return;
		}
		const timer = setTimeout(() => setShowQrFallback(true), 8_000);
		return () => clearTimeout(timer);
	}, [services.length]);

	useEffect(() => {
		let cancelled = false;
		void Promise.all(
			services.map(
				async (service) =>
					[
						service.id,
						await hasICloudTrustRecord(service.trustRecordId),
					] as const,
			),
		).then((entries) => {
			if (!cancelled) setIcloudTrust(Object.fromEntries(entries));
		});
		return () => {
			cancelled = true;
		};
	}, [services]);

	const requestAccess = useCallback(
		async (service: NearbyService) => {
			if (starting !== null || pending !== null) return;
			setStarting(service.id);
			setError(null);
			let proxy: LocalProxy | null = null;
			try {
				proxy = await openLocalProxy(service);
				const deviceId = await getOrCreateDeviceId();
				const publicKey = await pairingDevicePublicKey();
				const ephemeralPublicKey = ephemeralPairingPublicKey();
				const clientNonce = randomNonce();
				const challenge = await nearbyPairingChallenge(proxy);
				if (challenge.transportCertificatePin !== service.tlsCertificatePin) {
					throw new Error("The nearby Mac's encrypted identity did not match.");
				}
				let accountAssertion: string | undefined;
				if (useAuthStore.getState().account !== null) {
					try {
						accountAssertion = (
							await connectEnvironment(challenge.environmentId, {
								serverNonce: challenge.serverNonce,
								devicePublicKey: publicKey,
								transportCertificatePin: service.tlsCertificatePin,
							})
						).connectToken;
					} catch {
						// Account trust is opportunistic; explicit local approval remains.
					}
				}
				const trustRecordId =
					typeof service.trustRecordId === "string"
						? service.trustRecordId
						: undefined;
				const icloudChallenge =
					trustRecordId === undefined
						? undefined
						: [
								"zuse-icloud-v1",
								trustRecordId,
								deviceId,
								publicKey,
								clientNonce,
								challenge.serverNonce,
								challenge.environmentPublicKey,
								service.tlsCertificatePin,
							].join("|");
				const icloudTrustProof =
					trustRecordId === undefined || icloudChallenge === undefined
						? null
						: await proofForICloudTrustRecord(trustRecordId, icloudChallenge);
				const pairing = await startNearbyPairing({
					host: proxy.host,
					port: proxy.port,
					deviceId,
					deviceLabel: deviceLabel(),
					deviceModel: "iPhone",
					devicePublicKey: publicKey,
					ephemeralPublicKey,
					clientNonce,
					serverNonce: challenge.serverNonce,
					icloudTrustRecordId: trustRecordId,
					icloudTrustProof: icloudTrustProof ?? undefined,
					accountAssertion,
					transportCertificatePin: service.tlsCertificatePin,
				});
				setPending({
					requestId: pairing.request.requestId,
					safetyPhrase: pairing.safetyPhrase,
					deviceIdentifier: pairing.request.deviceIdentifier,
					environmentPublicKey: pairing.environmentPublicKey,
					service,
					proxy,
				});
			} catch (cause) {
				if (proxy !== null) await closeLocalProxy(proxy.id);
				setError(
					cause instanceof Error
						? cause.message
						: "Could not request access from this Mac.",
				);
			} finally {
				setStarting(null);
			}
		},
		[pending, starting],
	);

	useEffect(() => {
		if (services.length !== 1 || startedAutomatically.current) return;
		const service = services[0];
		if (service === undefined) return;
		startedAutomatically.current = true;
		void requestAccess(service);
	}, [requestAccess, services]);

	useEffect(() => {
		if (pending === null) return;
		let cancelled = false;
		let activeProxy: LocalProxy | null = pending.proxy;
		const finish = async () => {
			try {
				const status = await pollNearbyApproval({
					isCancelled: () => cancelled,
					readStatus: () =>
						nearbyPairingStatus({
							host: pending.proxy.host,
							port: pending.proxy.port,
							requestId: pending.requestId,
						}),
					onReadError: (cause, consecutiveFailures) => {
						console.warn("[zuse:nearby] pairing.status_read_failed", {
							requestId: pending.requestId,
							consecutiveFailures,
							cause,
						});
					},
				});
				if (cancelled || status === null) return;
				console.info("[zuse:nearby] pairing.status_terminal", {
					requestId: pending.requestId,
					state: status.state,
				});
				if (status.state !== "approved") {
					if (activeProxy !== null) await closeLocalProxy(activeProxy.id);
					activeProxy = null;
					setPending(null);
					setError(
						status.state === "denied"
							? "The Mac did not allow this phone."
							: "The connection request expired. Try again.",
					);
					return;
				}
				const credential = await decryptPairingCredential(status.credential);
				// The native proxy multiplexes pairing HTTP and the application socket
				// over one resolved Bonjour route, avoiding a second stale resolution.
				if (activeProxy === null) throw new Error("Nearby route was closed.");
				if (cancelled) {
					await closeLocalProxy(activeProxy.id);
					activeProxy = null;
					return;
				}
				await add({
					host: activeProxy.host,
					port: activeProxy.port,
					token: credential.token,
					source: "paired",
					serverKeyPin: serverKeyPin(pending.environmentPublicKey),
					serverPublicKey: pending.environmentPublicKey,
					transportCertificatePin: pending.service.tlsCertificatePin,
					nearbyServiceName: pending.service.name,
					pathType: pending.service.interfaceName?.startsWith("awdl")
						? "apple-peer"
						: "lan",
				});
				const completedProxy = activeProxy;
				activeProxy = null;
				setTimeout(() => void closeLocalProxy(completedProxy.id), 2_000);
				completed.current = true;
				successTap();
				returnToInbox(router);
			} catch (cause) {
				if (!cancelled) {
					if (activeProxy !== null) await closeLocalProxy(activeProxy.id);
					activeProxy = null;
					setPending(null);
					console.error("[zuse:nearby] pairing.finish_failed", {
						requestId: pending.requestId,
						cause,
					});
					setError(
						cause instanceof Error
							? cause.message
							: "Could not finish pairing.",
					);
				}
			}
		};
		void finish();
		return () => {
			cancelled = true;
		};
	}, [add, pending]);

	return (
		<>
			<ScrollView
				className="flex-1 bg-background"
				alwaysBounceVertical={false}
				contentInsetAdjustmentBehavior="never"
				contentContainerStyle={{
					minHeight: windowHeight,
					paddingHorizontal: 20,
					paddingTop: headerHeight + 12,
					paddingBottom: insets.bottom + 16,
				}}
			>
				{!localConnectivityAvailable ? (
					<View className="flex-1 justify-center gap-6">
						<EmptyState
							icon={Radio}
							title="Nearby connection unavailable"
							detail="This app build does not include nearby discovery. Scan the QR code or reinstall the native app."
						/>
						<Button onPress={() => router.replace("/connect/scan")}>
							Scan QR
						</Button>
					</View>
				) : pending !== null ? (
					<View className="flex-1 items-center justify-center gap-4 px-4 py-8">
						<View className="size-16 items-center justify-center rounded-full bg-primary/10">
							<ShieldCheck color={colors.accent} size={30} />
						</View>
						<View className="items-center gap-1.5">
							<Text className="font-sans-medium text-xl text-foreground">
								Approve on your Mac
							</Text>
							<Text className="max-w-72 text-center font-sans text-sm leading-5 text-muted-foreground">
								Confirm these words match, then choose Allow.
							</Text>
						</View>
						<Text
							selectable
							className="rounded-full border border-border bg-muted/40 px-5 py-3 font-mono text-base text-foreground"
						>
							{safetyPhraseLabel(pending.safetyPhrase)}
						</Text>
						<View className="flex-row items-center gap-2 pt-1">
							<ActivityIndicator size="small" />
							<Text className="font-sans text-sm text-muted-foreground">
								Waiting for approval · Device {pending.deviceIdentifier}
							</Text>
						</View>
					</View>
				) : starting !== null ? (
					<View className="flex-1 items-center justify-center gap-5 py-8">
						<View className="size-24 items-center justify-center rounded-full border border-border bg-muted/40">
							<Monitor color={colors.fg} size={38} />
						</View>
						<View className="items-center gap-2">
							<Text className="font-sans-medium text-lg text-foreground">
								Connecting…
							</Text>
							<Text className="font-sans text-sm text-muted-foreground">
								Securing the nearby connection
							</Text>
						</View>
						<ActivityIndicator />
					</View>
				) : (
					<View className="flex-1 pt-4">
						<Text className="mx-auto max-w-80 text-center font-sans text-sm leading-5 text-muted-foreground">
							Nearby Macs appear automatically over Wi-Fi or peer-to-peer.
						</Text>
						{services.length === 0 ? (
							<View className="flex-1 items-center justify-center gap-3 py-8">
								<ActivityIndicator />
								<Text className="font-sans text-sm text-muted-foreground">
									Looking for nearby Macs…
								</Text>
								{showQrFallback ? (
									<>
										<Text className="max-w-72 text-center font-sans text-sm leading-5 text-muted-foreground">
											{discoveryState.state === "waiting" ||
											discoveryState.state === "failed"
												? "Nearby access is unavailable. Check Local Network access for Zuse in iPhone Settings."
												: "Keep Zuse open on the Mac and make sure both devices have Wi-Fi enabled."}
										</Text>
										<Button
											variant="secondary"
											onPress={() => router.push("/connect/scan")}
										>
											Scan QR instead
										</Button>
									</>
								) : null}
							</View>
						) : (
							<View className="flex-row flex-wrap justify-center gap-5 pt-10">
								{services.map((service) => (
									<Pressable
										key={service.id}
										accessibilityRole="button"
										accessibilityLabel={`${nearbyMacDisplayName(service.name)}, ${iCloudTrustLabel(icloudTrust[service.id])}`}
										disabled={starting !== null}
										onPress={() => void requestAccess(service)}
										className="min-h-44 w-40 items-center justify-start gap-3 rounded-3xl px-3 py-4 active:bg-muted/60"
									>
										<View className="size-24 items-center justify-center rounded-full border border-border bg-muted/40">
											<Monitor color={colors.fg} size={38} />
										</View>
										<View className="w-full items-center gap-1">
											<Text
												numberOfLines={2}
												className="text-center font-sans-medium text-base text-foreground"
											>
												{nearbyMacDisplayName(service.name)}
											</Text>
											<View className="min-h-5 flex-row items-center gap-1.5">
												<Cloud color={colors.secondaryFg} size={13} />
												<Text className="font-sans text-xs text-muted-foreground">
													{iCloudTrustLabel(icloudTrust[service.id])}
												</Text>
											</View>
										</View>
									</Pressable>
								))}
							</View>
						)}
						{error === null ? null : (
							<View accessibilityRole="alert" className="pb-4 pt-4">
								<Text
									selectable
									className="text-center font-sans text-sm text-danger"
								>
									{error}
								</Text>
								<Button
									variant="secondary"
									className="mt-3"
									onPress={() => router.push("/connect/scan")}
								>
									Scan QR instead
								</Button>
							</View>
						)}
					</View>
				)}
			</ScrollView>
			<Stack.Screen options={{ title: "Nearby Macs" }} />
		</>
	);
}
