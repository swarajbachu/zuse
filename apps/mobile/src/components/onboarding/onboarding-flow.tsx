import {
	BoltIcon,
	CloudIcon,
	ComputerIcon,
	QrCodeIcon,
	SecurityCheckIcon,
	SmartPhone01Icon,
} from "@zuse/icons/solid-rounded";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import {
	Image,
	Pressable,
	ScrollView,
	Text,
	useWindowDimensions,
	View,
} from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { signIn } from "~/store/auth";
import { completeOnboarding } from "~/store/onboarding";
import { colors } from "~/theme";
import { Button } from "../ui/button";
import { HugeIcon } from "../ui/huge-icon";

const LOGO = require("../../../assets/icon.png");

const pages = [
	{
		kind: "welcome",
		eyebrow: "ZUSE FOR IPHONE",
		title: "Your agents, within reach.",
		detail:
			"Follow every task, answer questions, and keep work moving when you step away from your computer.",
	},
	{
		kind: "features",
		eyebrow: "STAY IN CONTROL",
		title: "Everything important travels with you.",
		detail:
			"Your phone becomes a focused companion for the work already running in Zuse.",
	},
	{
		kind: "setup",
		eyebrow: "CONNECT YOUR COMPUTER",
		title: "Pair in under a minute.",
		detail: "Keep Zuse open on your computer, then follow these three steps.",
	},
	{
		kind: "ready",
		eyebrow: "READY TO CONNECT",
		title: "Choose how you want to begin.",
		detail:
			"Scan the QR shown by Zuse, find a nearby Mac automatically, or sign in for remote access.",
	},
] as const;

const features = [
	{
		icon: BoltIcon,
		title: "Follow live work",
		detail: "See responses and task progress as they happen.",
	},
	{
		icon: SmartPhone01Icon,
		title: "Respond from anywhere",
		detail: "Approve actions, answer questions, and send follow-ups.",
	},
	{
		icon: SecurityCheckIcon,
		title: "Private by design",
		detail: "Pair trusted devices and keep control of every connection.",
	},
] as const;

const setupSteps = [
	["1", "Open Zuse on your computer"],
	["2", "Go to Settings, then Remote access"],
	["3", "Choose Show QR and scan it here"],
] as const;

export function OnboardingFlow({ replay = false }: { replay?: boolean }) {
	const [page, setPage] = useState(0);
	const insets = useSafeAreaInsets();
	const { height } = useWindowDimensions();
	const current = pages[page] ?? pages[0];
	const finalPage = page === pages.length - 1;

	const leaveFor = async (
		destination: "/" | "/connect/scan" | "/connect/nearby",
	) => {
		await completeOnboarding();
		if (destination === "/" && replay && router.canGoBack()) {
			router.back();
			return;
		}
		router.replace(destination);
	};

	const signInAndFinish = async () => {
		await completeOnboarding();
		await signIn();
		router.replace("/");
	};

	return (
		<View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
			<View className="h-12 flex-row items-center justify-between px-5">
				<View className="flex-row items-center gap-2">
					<Image source={LOGO} className="h-8 w-8 rounded-[10px]" />
					<Text className="font-sans-bold text-[17px] text-foreground">
						Zuse
					</Text>
				</View>
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="Skip onboarding"
					hitSlop={10}
					onPress={() => void leaveFor("/")}
					className="px-2 py-2 active:opacity-60"
				>
					<Text className="font-sans-medium text-[15px] text-primary">
						Skip
					</Text>
				</Pressable>
			</View>

			<ScrollView
				className="flex-1"
				contentInsetAdjustmentBehavior="never"
				showsVerticalScrollIndicator={false}
				contentContainerStyle={{ minHeight: Math.max(height - 260, 500) }}
			>
				<Animated.View
					key={page}
					entering={FadeIn.duration(180)}
					exiting={FadeOut.duration(120)}
					className="flex-1 justify-center px-6 py-8"
				>
					<PageArtwork kind={current.kind} />
					<View className="mt-8 items-center gap-3">
						<Text className="font-sans-bold text-xs tracking-[1.4px] text-primary">
							{current.eyebrow}
						</Text>
						<Text className="max-w-[350px] text-center font-sans-bold text-[30px] leading-[35px] tracking-[-0.7px] text-foreground">
							{current.title}
						</Text>
						<Text className="max-w-[350px] text-center font-sans text-[16px] leading-[23px] text-muted-foreground">
							{current.detail}
						</Text>
					</View>
					{current.kind === "features" ? <FeatureList /> : null}
					{current.kind === "setup" ? <SetupList /> : null}
				</Animated.View>
			</ScrollView>

			<View
				className="gap-4 px-5 pt-3"
				style={{ paddingBottom: Math.max(insets.bottom, 16) }}
			>
				<View className="flex-row items-center justify-center gap-2">
					{pages.map((item, index) => (
						<View
							key={item.kind}
							className={
								index === page
									? "h-2 w-6 rounded-full bg-primary"
									: "h-2 w-2 rounded-full bg-muted"
							}
						/>
					))}
				</View>
				{finalPage ? (
					<View className="gap-2.5">
						<Button onPress={() => void leaveFor("/connect/scan")}>
							<SymbolView
								name="qrcode.viewfinder"
								size={17}
								weight="semibold"
								tintColor={colors.primaryForeground}
							/>
							Scan QR code
						</Button>
						<Button
							variant="secondary"
							onPress={() => void leaveFor("/connect/nearby")}
						>
							<SymbolView
								name="wifi"
								size={17}
								weight="semibold"
								tintColor={colors.fg}
							/>
							Find nearby Mac
						</Button>
						<Pressable
							className="items-center py-2"
							onPress={() => void signInAndFinish()}
						>
							<Text className="font-sans-medium text-[15px] text-primary">
								Sign in for remote access
							</Text>
						</Pressable>
					</View>
				) : (
					<Button
						onPress={() =>
							setPage((value) => Math.min(value + 1, pages.length - 1))
						}
					>
						{page === 0 ? "Get started" : "Continue"}
						<SymbolView
							name="arrow.right"
							size={16}
							weight="semibold"
							tintColor={colors.primaryForeground}
						/>
					</Button>
				)}
			</View>
		</View>
	);
}

function PageArtwork({ kind }: { kind: (typeof pages)[number]["kind"] }) {
	const icon =
		kind === "welcome"
			? CloudIcon
			: kind === "features"
				? SmartPhone01Icon
				: kind === "setup"
					? ComputerIcon
					: QrCodeIcon;
	return (
		<View className="items-center justify-center">
			<View className="absolute h-44 w-44 rounded-full bg-primary/10" />
			<View
				style={{ borderCurve: "continuous" }}
				className="h-28 w-28 items-center justify-center rounded-[32px] bg-card"
			>
				<HugeIcon
					icon={icon}
					size={48}
					color={colors.accent}
					strokeWidth={1.8}
				/>
			</View>
		</View>
	);
}

function FeatureList() {
	return (
		<View className="mx-auto mt-8 w-full max-w-[380px] gap-3">
			{features.map((feature) => (
				<View
					key={feature.title}
					className="flex-row items-center gap-3 rounded-2xl bg-card px-4 py-3"
				>
					<View className="h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
						<HugeIcon
							icon={feature.icon}
							size={20}
							color={colors.accent}
							strokeWidth={1.8}
						/>
					</View>
					<View className="min-w-0 flex-1 gap-0.5">
						<Text className="font-sans-medium text-[16px] text-foreground">
							{feature.title}
						</Text>
						<Text className="font-sans text-[13px] leading-[18px] text-muted-foreground">
							{feature.detail}
						</Text>
					</View>
				</View>
			))}
		</View>
	);
}

function SetupList() {
	return (
		<View className="mx-auto mt-8 w-full max-w-[380px] overflow-hidden rounded-3xl bg-card">
			{setupSteps.map(([number, label], index) => (
				<View key={number}>
					{index > 0 ? <View className="ml-[68px] h-px bg-border" /> : null}
					<View className="min-h-16 flex-row items-center gap-4 px-4 py-3">
						<View className="h-9 w-9 items-center justify-center rounded-full bg-primary">
							<Text className="font-sans-bold text-[14px] text-primary-foreground">
								{number}
							</Text>
						</View>
						<Text className="min-w-0 flex-1 font-sans-medium text-[15px] leading-5 text-foreground">
							{label}
						</Text>
					</View>
				</View>
			))}
		</View>
	);
}
