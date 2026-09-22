"use client";
import { useWebsiteMessages } from "@zuse/i18n/website/react";
import type React from "react";
import { cn } from "@/components/tpl/saas/lib/utils";
import { Container } from "../container";
import { Heading } from "../heading";
import { ChatConversation } from "./chat";
import { FlippingImagesWithBar } from "./flipping-images";
import { KeyboardSkeleton } from "./keyboard-skeleton";
import { LoginSkeleton } from "./login-skeleton";
import { VerticalPulseLines } from "./vertical-pulse-lines";
import { WorldMapSkeleton } from "./world-map-skeleton";

export function FeaturesOne() {
	const { message: t } = useWebsiteMessages();

	return (
		<Container as="section" id="product" className="py-10 md:py-20 lg:py-32">
			<Heading as="h2">{t("showcase:browser_verification_built_in")}</Heading>
			<div className="mx-auto mt-8 grid grid-cols-1 gap-4 md:mt-12 md:grid-cols-3 md:grid-rows-2">
				<Card className="md:row-span-2">
					<CardContent className="flex h-full flex-col">
						<CardHeader>
							<CardTitle>{t("showcase:import_browser_sessions")}</CardTitle>
						</CardHeader>
						<CardSkeleton className="mt-auto flex flex-1 items-center justify-center overflow-hidden pt-4">
							<LoginSkeleton />
						</CardSkeleton>
					</CardContent>
				</Card>

				<Card>
					<CardContent className="flex h-full flex-col">
						<CardHeader>
							<CardTitle>{t("showcase:drive_the_whole_flow")}</CardTitle>
						</CardHeader>
						<CardSkeleton className="mt-auto flex flex-1 items-center justify-center pt-4">
							<WorldMapSkeleton />
						</CardSkeleton>
					</CardContent>
				</Card>

				<Card className="md:row-span-2">
					<CardContent className="flex h-full flex-col">
						<CardHeader>
							<CardTitle>{t("showcase:watch_browser_actions_live")}</CardTitle>
						</CardHeader>
						<CardSkeleton className="mt-auto flex flex-1 flex-col items-center justify-between gap-2 overflow-hidden pt-4">
							<ChatConversation className="min-h-0 shrink p-2" />
							<VerticalPulseLines className="h-24 shrink-0" />
							<div className="shrink-0 scale-75">
								<FlippingImagesWithBar />
							</div>
						</CardSkeleton>
					</CardContent>
				</Card>

				<Card>
					<CardContent className="flex h-full flex-col">
						<CardHeader>
							<CardTitle>{t("showcase:describe_what_to_verify")}</CardTitle>
						</CardHeader>
						<CardSkeleton className="mask-r-from-50% mt-auto flex flex-1 items-center justify-center overflow-hidden pt-4">
							<KeyboardSkeleton />
						</CardSkeleton>
					</CardContent>
				</Card>
			</div>
		</Container>
	);
}

function Card({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"bg-card ring-border rounded-2xl shadow-sm ring-1 shadow-black/10",
				className,
			)}
		>
			{children}
		</div>
	);
}

function CardContent({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return <div className={cn("", className)}>{children}</div>;
}

function CardHeader({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex flex-col gap-2 p-6", className)}>{children}</div>
	);
}

function CardTitle({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<h3 className={cn("text-heading text-3xl font-light", className)}>
			{children}
		</h3>
	);
}

function CardSkeleton({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return <div className={cn(className)}>{children}</div>;
}
