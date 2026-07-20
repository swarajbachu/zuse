import * as ExpoCrypto from "expo-crypto";
import { router, Stack } from "expo-router";
import { Monitor, Radio, ShieldCheck } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/empty-state";
import { returnToInbox } from "~/lib/connection-navigation";
import { deviceLabel, getOrCreateDeviceId } from "~/lib/device-identity";
import { successTap } from "~/lib/haptics";
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

import {
	closeLocalProxy,
	type LocalProxy,
	localConnectivityAvailable,
	type NearbyService,
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

const randomNonce = (): string =>
	Array.from(ExpoCrypto.getRandomBytes(18), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");

export default function NearbyConnectScreen() {
	const add = useConnectionsStore((state) => state.add);
	const [services, setServices] = useState<readonly NearbyService[]>([]);
	const [pending, setPending] = useState<PendingApproval | null>(null);
	const [starting, setStarting] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [showQrFallback, setShowQrFallback] = useState(false);
	const startedAutomatically = useRef(false);
	const completed = useRef(false);

	useEffect(() => {
		void startLocalDiscovery();
		const unsubscribe = onNearbyServicesChanged(setServices);
		return unsubscribe;
	}, []);

	useEffect(() => {
		if (services.length > 0) {
			setShowQrFallback(false);
			return;
		}
		const timer = setTimeout(() => setShowQrFallback(true), 8_000);
		return () => clearTimeout(timer);
	}, [services.length]);

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
				const icloudChallenge =
					service.trustRecordId === undefined
						? undefined
						: [
								"zuse-icloud-v1",
								service.trustRecordId,
								deviceId,
								publicKey,
								clientNonce,
								challenge.serverNonce,
								challenge.environmentPublicKey,
								service.tlsCertificatePin,
							].join("|");
				const icloudTrustProof =
					service.trustRecordId === undefined || icloudChallenge === undefined
						? null
						: await proofForICloudTrustRecord(
								service.trustRecordId,
								icloudChallenge,
							);
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
					icloudTrustRecordId: service.trustRecordId,
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
		const check = async () => {
			try {
				const status = await nearbyPairingStatus({
					host: pending.proxy.host,
					port: pending.proxy.port,
					requestId: pending.requestId,
				});
				if (cancelled || status.state === "pending") return;
				if (status.state !== "approved") {
					await closeLocalProxy(pending.proxy.id);
					setPending(null);
					setError(
						status.state === "denied"
							? "The Mac did not allow this phone."
							: "The connection request expired. Try again.",
					);
					return;
				}
				const credential = await decryptPairingCredential(status.credential);
				await add({
					host: pending.proxy.host,
					port: pending.proxy.port,
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
				setTimeout(() => void closeLocalProxy(pending.proxy.id), 2_000);
				completed.current = true;
				successTap();
				returnToInbox(router);
			} catch (cause) {
				if (!cancelled) {
					setError(
						cause instanceof Error
							? cause.message
							: "Could not finish pairing.",
					);
				}
			}
		};
		void check();
		const timer = setInterval(() => void check(), 1_000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [add, pending]);

	if (!localConnectivityAvailable) {
		return (
			<View className="flex-1 justify-center gap-6 bg-background px-5">
				<EmptyState
					icon={Radio}
					title="Nearby connection unavailable"
					detail="Use the QR scanner with this build."
				/>
				<Button onPress={() => router.replace("/connect/scan")}>Scan QR</Button>
			</View>
		);
	}

	return (
		<View className="flex-1 bg-background px-5">
			<Stack.Screen options={{ title: "Nearby Macs" }} />
			{pending !== null ? (
				<View className="flex-1 items-center justify-center gap-5">
					<View className="size-14 items-center justify-center rounded-2xl bg-primary/10">
						<ShieldCheck size={28} />
					</View>
					<View className="items-center gap-2">
						<Text className="font-sans-medium text-xl text-foreground">
							Check your Mac
						</Text>
						<Text className="max-w-72 text-center font-sans text-sm leading-5 text-muted-foreground">
							Make sure this phrase matches, then click Allow on the Mac.
						</Text>
					</View>
					<Text
						selectable
						className="rounded-2xl border border-border bg-muted/40 px-5 py-4 font-mono text-lg text-foreground"
					>
						{pending.safetyPhrase}
					</Text>
					<Text className="font-sans text-sm text-muted-foreground">
						Device {pending.deviceIdentifier}
					</Text>
					<ActivityIndicator />
				</View>
			) : (
				<View className="flex-1 pt-6">
					<Text className="font-sans text-sm leading-5 text-muted-foreground">
						Macs running Zuse appear automatically over Wi-Fi or Apple
						peer-to-peer.
					</Text>
					{services.length === 0 ? (
						<View className="flex-1 items-center justify-center gap-3">
							<ActivityIndicator />
							<Text className="font-sans text-sm text-muted-foreground">
								Looking for nearby Macs…
							</Text>
							{showQrFallback ? (
								<Button
									variant="secondary"
									onPress={() => router.push("/connect/scan")}
								>
									Scan QR instead
								</Button>
							) : null}
						</View>
					) : (
						<View className="mt-5 gap-2">
							{services.map((service) => (
								<Pressable
									key={service.id}
									accessibilityRole="button"
									disabled={starting !== null}
									onPress={() => void requestAccess(service)}
									className="min-h-14 flex-row items-center gap-3 rounded-2xl border border-border px-4 active:bg-muted/60"
								>
									<Monitor size={20} />
									<Text className="min-w-0 flex-1 font-sans-medium text-base text-foreground">
										{service.name}
									</Text>
									{starting === service.id ? <ActivityIndicator /> : null}
								</Pressable>
							))}
						</View>
					)}
					{error === null ? null : (
						<View accessibilityRole="alert" className="pb-4">
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
		</View>
	);
}
