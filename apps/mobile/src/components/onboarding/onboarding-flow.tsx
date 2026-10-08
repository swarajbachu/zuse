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
			"In phone Settings, open Cloud Providers to check the agent accounts used by your cloud chats.",
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
			? "Local or cloud. You can use both and add the other later."
			: step === 1
				? local
					? "Install and open Zuse on your computer."
					: "Agents run in hosted environments. No desktop pairing or shared Wi-Fi needed."
				: step === 2
					? "Do these steps in the desktop app."
					: local
						? "Create a pairing code on desktop, then scan it here."
						: "Sign in to reach your cloud sandboxes.";
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
				<Button
					size="sm"
					variant="ghost"
					disabled={busy}
					onPress={() => run(finish)}
				>
					Skip
				</Button>
			</View>
			<ScrollView
				key={step}
				contentInsetAdjustmentBehavior="never"
				contentContainerStyle={{ flexGrow: 1, padding: 24, paddingTop: 20 }}
			>
				<View className="mx-auto w-full max-w-[380px] gap-7">
					<View className="gap-3">
						<Text className="font-sans-bold text-xs tracking-[1px] text-accent">
							STEP {step + 1} OF {path === "cloud" ? 2 : 4} ·{" "}
							{cloudReady ? "CLOUD SANDBOXES" : stages[step]?.toUpperCase()}
						</Text>
						<Text
							accessibilityRole="header"
							className="font-sans-bold text-[28px] leading-[34px] tracking-[-0.6px] text-foreground"
						>
							{title}
						</Text>
						<Text className="font-sans text-[15px] leading-[21px] text-muted-foreground">
							{detail}
						</Text>
					</View>
					{step === 1 && local ? (
						<>
							<Instructions
								items={[
									[
										"Download Zuse",
										"On your computer, download it from zuse.sh.",
									],
									["Install and open it", "Launch Zuse and leave it open."],
								]}
							/>
							<Button variant="secondary" onPress={() => run(copyDownload)}>
								{copied ? "Link Copied" : "Copy Download Link"}
							</Button>
							<Text className="text-sm leading-5 text-muted-foreground">
								Already installed? Open it and continue.
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
											? "Hosted environments. Your computer can stay off."
											: "Pair on the same Wi-Fi. No account needed."}
									</Text>
								</Pressable>
							))}
							<Text className="text-sm leading-5 text-muted-foreground">
								{
									"Add the other anytime in Settings → Remote access or Settings → Connections."
								}
							</Text>
						</View>
					) : null}
					{cloudReady ? <Instructions items={setupInstructions.cloud} /> : null}
					{step === 2 && path ? (
						<>
							<Instructions items={setupInstructions[path]} />
							{local ? (
								<Text className="rounded-2xl bg-card-elevated p-4 text-sm leading-5 text-foreground">
									Restarting stops running agents. Finish or pause work first.
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
										"Tap Scan QR Code below and point at the desktop code.",
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
						disabled={step === 0 && path === null}
						onPress={() => setStep((value) => Math.min(3, value + 1))}
					>
						{step === 0
							? "Continue"
							: step === 1
								? "Zuse Is Open"
								: local
									? "Local Access Is On"
									: "Continue"}
					</Button>
				) : local ? (
					<>
						<Button onPress={() => router.push("/connect/scan")}>
							Scan QR Code
						</Button>
						<Button
							size="sm"
							variant="ghost"
							onPress={() => router.push("/connect/nearby")}
						>
							Find Nearby Mac
						</Button>
					</>
				) : (
					<Button disabled={busy} onPress={() => run(connectCloud)}>
						{busy ? "Signing In…" : account ? "Open Inbox" : "Sign In"}
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
