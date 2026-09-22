import { useAtomValue } from "@effect/atom-react";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { platformSymbolName } from "~/lib/symbol-names";
import {
	authAccountAtom,
	authBusyAtom,
	authErrorAtom,
	signIn,
} from "~/store/auth";
import { completeOnboarding } from "~/store/onboarding";
import { appAtomRegistry } from "~/store/registry";
import { colors } from "~/theme";
import { Button } from "../ui/button";

type ConnectionPath = "cloud" | "local";
const stages = ["Connection", "Desktop", "Settings", "Connect"] as const;
const setupInstructions = {
	cloud: [
		[
			"Sign in to Zuse",
			"Use the account that has access to your hosted cloud sandboxes.",
		],
		[
			"Open your cloud work",
			"Your existing cloud chats appear in the inbox after sign-in.",
		],
		[
			"Check agent authentication",
			"In phone Settings, open Cloud Authentication to check the agent accounts used by your cloud chats.",
		],
	],
	local: [
		[
			"Use the same Wi-Fi",
			"Connect your phone and computer to the same trusted network.",
		],
		[
			"Turn on Local network",
			"Open Settings → Remote access. Under Connections, choose Turn on beside Local network.",
		],
		[
			"Confirm the restart",
			"In Turn on local access?, choose Restart and turn on. Wait for Zuse to reopen.",
		],
	],
} as const;

export function OnboardingFlow({ replay = false }: { replay?: boolean }) {
	const [step, setStep] = useState(0);
	const [path, setPath] = useState<ConnectionPath | null>(null);
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const busy = useAtomValue(authBusyAtom);
	const authError = useAtomValue(authErrorAtom);
	const account = useAtomValue(authAccountAtom);
	const insets = useSafeAreaInsets();
	const local = path === "local";
	const cloudReady = step === 1 && path === "cloud";
	const finish = async () => {
		await completeOnboarding();
		if (replay && router.canGoBack()) router.back();
		else router.replace("/");
	};
	const connectCloud = async () => {
		if (!account) await signIn();
		if (appAtomRegistry.get(authAccountAtom)) await finish();
	};
	const copyDownload = async () => {
		await Clipboard.setStringAsync("https://zuse.sh");
		setCopied(true);
	};
	const run = (action: () => Promise<void>) => {
		setError(null);
		void action().catch(() =>
			setError("Could not continue. Please try again."),
		);
	};
	const title =
		step === 0
			? "Where will your agents run?"
			: step === 1
				? local
					? "Start on your computer."
					: "Work in cloud sandboxes."
				: step === 2
					? local
						? "Enable local access."
						: "Your cloud account."
					: local
						? "Pair your phone."
						: "Sign in on your phone.";
	const detail =
		step === 0
			? "Choose local work on your computer or hosted cloud sandboxes. You can use both and add the other from Settings anytime."
			: step === 1
				? local
					? "Install and open Zuse on your computer. This path connects your phone to work running there."
					: "Agents run in hosted environments, not on your computer. No desktop pairing, Zuse Serve, or shared Wi-Fi is needed."
				: step === 2
					? "Do these steps in the desktop app. Keep this guide open on your phone."
					: local
						? "Create a pairing code in the desktop app, then scan it here."
						: "Sign in to access your hosted cloud sandboxes.";
	return (
		<View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
			<View className="min-h-12 flex-row items-center justify-between px-5">
				<Pressable
					disabled={step === 0 || busy}
					accessibilityRole="button"
					accessibilityLabel="Previous step"
					onPress={() => setStep((value) => Math.max(0, value - 1))}
					className="min-h-11 min-w-11 justify-center active:opacity-60"
				>
					{step > 0 ? (
						<SymbolView
							name={platformSymbolName("chevron.left")}
							size={20}
							tintColor={colors.fg}
						/>
					) : (
						<Text className="font-sans-bold text-base text-foreground">
							Zuse
						</Text>
					)}
				</Pressable>
				<Button variant="ghost" disabled={busy} onPress={() => run(finish)}>
					Set up later
				</Button>
			</View>
			<ScrollView
				key={step}
				contentInsetAdjustmentBehavior="never"
				contentContainerStyle={{ flexGrow: 1, padding: 24, paddingTop: 32 }}
			>
				<View className="mx-auto w-full max-w-[380px] gap-8">
					<View className="gap-3">
						<Text className="font-sans-bold text-xs tracking-[1px] text-accent">
							STEP {step + 1} OF {path === "cloud" ? 2 : 4} ·{" "}
							{cloudReady ? "CLOUD SANDBOXES" : stages[step]?.toUpperCase()}
						</Text>
						<Text
							accessibilityRole="header"
							className="font-sans-bold text-[32px] leading-[38px] tracking-[-0.8px] text-foreground"
						>
							{title}
						</Text>
						<Text className="font-sans text-base leading-6 text-muted-foreground">
							{detail}
						</Text>
					</View>
					{step === 1 && local ? (
						<>
							<Instructions
								items={[
									[
										"Download Zuse",
										"On your computer, open zuse.sh and download the desktop app for your platform.",
									],
									[
										"Install and open it",
										"Finish installation, then launch Zuse. Leave it open while you connect your phone.",
									],
								]}
							/>
							<Button variant="secondary" onPress={() => run(copyDownload)}>
								{copied ? "Download link copied" : "Copy desktop download link"}
							</Button>
							<Text className="text-sm leading-5 text-muted-foreground">
								Already installed? Open Zuse on your computer and continue
								below.
							</Text>
						</>
					) : null}
					{step === 0 ? (
						<View className="gap-3">
							{(["cloud", "local"] as const).map((value) => (
								<Pressable
									key={value}
									accessibilityRole="radio"
									accessibilityState={{ checked: path === value }}
									onPress={() => setPath(value)}
									className={
										path === value
											? "gap-3 rounded-2xl border border-primary bg-primary/10 p-5 active:opacity-80"
											: "gap-3 rounded-2xl border border-transparent bg-card-elevated p-5 active:opacity-80"
									}
								>
									<View className="flex-row items-center justify-between">
										<Text className="font-sans-bold text-lg text-foreground">
											{value === "cloud"
												? "Cloud sandboxes"
												: "Local connection"}
										</Text>
										<SymbolView
											name={platformSymbolName(
												path === value
													? "checkmark.circle.fill"
													: value === "cloud"
														? "cloud.fill"
														: "wifi",
											)}
											size={22}
											weight="light"
											tintColor={colors.accent}
										/>
									</View>
									<Text className="text-sm leading-5 text-muted-foreground">
										{value === "cloud"
											? "Run agents in hosted cloud environments. Sign in to your Zuse account; your computer does not need to stay on."
											: "Pair directly on the same Wi-Fi. No account needed. Best when your computer is nearby."}
									</Text>
								</Pressable>
							))}
							<Text className="text-sm leading-5 text-muted-foreground">
								Choosing local does not lock you out of cloud. Later, open
								Settings → Remote access to sign in. To add local pairing, use
								Settings → Connections. Only local work needs your computer
								awake with Zuse running.
							</Text>
						</View>
					) : null}
					{cloudReady ? <Instructions items={setupInstructions.cloud} /> : null}
					{step === 2 && path ? (
						<>
							<Instructions items={setupInstructions[path]} />
							{local ? (
								<Text className="rounded-2xl bg-card-elevated p-4 text-sm leading-5 text-foreground">
									Before restarting: running agents will stop. Finish or pause
									your work first.
								</Text>
							) : null}
						</>
					) : null}
					{step === 3 ? (
						local ? (
							<Instructions
								items={[
									[
										"Create a connect link",
										"On desktop, return to Settings → Remote access. Under Connect another device, choose Create link.",
									],
									[
										"Show the local QR code",
										"Set Connect through to Local network, then choose Show QR. The link lasts five minutes; create a new one if it expires.",
									],
									[
										"Scan from this phone",
										"Tap Scan QR code below, then point at the desktop code. Scanning uses the camera; connecting to your desktop uses local network access.",
									],
								]}
							/>
						) : (
							<Instructions
								items={[
									[
										"Open your cloud chats",
										"Existing cloud chats appear in your inbox after sign-in.",
									],
									[
										"Use the same account",
										"Use your cloud sandbox account. You can switch accounts in phone Settings.",
									],
									[
										"Find your work",
										"If cloud chats are missing, check your account and internet connection.",
									],
								]}
							/>
						)
					) : null}
					{error || (cloudReady && authError) ? (
						<Text
							selectable
							accessibilityRole="alert"
							className="text-sm text-danger"
						>
							{error ?? authError}
						</Text>
					) : null}
				</View>
			</ScrollView>
			<View
				className="gap-2 px-6 pt-3"
				style={{ paddingBottom: Math.max(insets.bottom, 16) }}
			>
				{step < 3 && !cloudReady ? (
					<Button
						className="h-14"
						disabled={step === 0 && path === null}
						onPress={() => setStep((value) => Math.min(3, value + 1))}
					>
						{step === 0
							? "Continue"
							: step === 1
								? "Zuse is open on my computer"
								: local
									? "Local access is on"
									: "Continue"}
					</Button>
				) : local ? (
					<>
						<Button
							className="h-14"
							onPress={() => router.push("/connect/scan")}
						>
							Scan QR code
						</Button>
						<Button
							variant="ghost"
							onPress={() => router.push("/connect/nearby")}
						>
							Find nearby Mac instead
						</Button>
					</>
				) : (
					<Button
						className="h-14"
						disabled={busy}
						onPress={() => run(connectCloud)}
					>
						{busy ? "Signing in…" : account ? "Open my inbox" : "Sign in"}
					</Button>
				)}
			</View>
		</View>
	);
}

function Instructions({
	items,
}: {
	items: readonly (readonly [string, string])[];
}) {
	return (
		<View className="gap-6">
			{items.map(([title, detail], index) => (
				<View key={title} className="flex-row gap-4">
					<View className="h-8 w-8 items-center justify-center rounded-full bg-card-elevated">
						<Text className="font-sans-bold text-sm text-accent">
							{index + 1}
						</Text>
					</View>
					<View className="flex-1 gap-1">
						<Text className="font-sans-bold text-base text-foreground">
							{title}
						</Text>
						<Text className="text-sm leading-5 text-muted-foreground">
							{detail}
						</Text>
					</View>
				</View>
			))}
		</View>
	);
}
