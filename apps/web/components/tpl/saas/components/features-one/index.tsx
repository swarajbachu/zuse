"use client";
import { useWebsiteMessages } from "@zuse/i18n/website/react";
import { Cookie, Monitor, RefreshCw } from "lucide-react";
import type React from "react";
import { cn } from "@/components/tpl/saas/lib/utils";
import { Container } from "../container";
import { Heading } from "../heading";
import { Subheading } from "../subheading";
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
			<Subheading className="mt-2">
				{t(
					"showcase:let_an_agent_drive_a_real_browser_and_verify_the_flow_inside_zuse",
				)}
			</Subheading>
			<div className="mx-auto mt-8 grid grid-cols-1 gap-4 md:mt-12 md:grid-cols-3 md:grid-rows-2">
				<Card className="md:row-span-2">
					<CardContent className="flex h-full flex-col">
						<CardHeader>
							<CardTitle>{t("showcase:import_browser_sessions")}</CardTitle>
							<CardDescription>
								{t(
									"showcase:copy_valid_cookies_from_a_local_browser_profile_into_zuse_s_built_in_b",
								)}
							</CardDescription>
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
							<CardDescription>
								{t(
									"showcase:navigate_fill_forms_click_controls_and_inspect_the_resulting_page_stat",
								)}
							</CardDescription>
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
							<CardDescription>
								{t(
									"showcase:see_the_page_as_the_agent_works_and_keep_screenshots_and_results_in_th",
								)}
							</CardDescription>
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
							<CardDescription>
								{t(
									"showcase:give_the_agent_the_flow_and_expected_result_it_performs_the_browser_ac",
								)}
							</CardDescription>
						</CardHeader>
						<CardSkeleton className="mask-r-from-50% mt-auto flex flex-1 items-center justify-center overflow-hidden pt-4">
							<KeyboardSkeleton />
						</CardSkeleton>
					</CardContent>
				</Card>
			</div>

			<div className="mx-auto mt-4 grid grid-cols-1 gap-4 md:mt-12 md:grid-cols-3">
				<FeatureCard
					icon={<Cookie className="group-hover:text-primary size-5" />}
					title={t("showcase:signed_in_sessions")}
					description={t(
						"showcase:copy_valid_cookies_from_a_local_browser_profile_passwords_are_never_im",
					)}
				/>
				<FeatureCard
					icon={<Monitor className="group-hover:text-primary size-5" />}
					title={t("showcase:a_real_headless_browser")}
					description={t(
						"showcase:tests_drive_an_actual_browser_clicks_typing_navigation_and_assertions",
					)}
				/>
				<FeatureCard
					icon={<RefreshCw className="group-hover:text-primary size-5" />}
					title={t("showcase:inspect_and_retry")}
					description={t(
						"showcase:the_agent_can_inspect_the_current_page_state_adjust_the_implementation",
					)}
				/>
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
		<h3 className={cn("text-heading text-sm font-semibold", className)}>
			{children}
		</h3>
	);
}

function CardDescription({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<p className={cn("text-muted-foreground text-sm text-balance", className)}>
			{children}
		</p>
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

function FeatureCard({
	icon,
	title,
	description,
}: {
	icon: React.ReactNode;
	title: string;
	description: string;
}) {
	return (
		<div className="group bg-card rounded-2xl p-6">
			{icon}
			<h3 className="text-heading mt-4 text-sm font-semibold">{title}</h3>
			<p className="text-muted-foreground mt-2 text-sm text-balance">
				{description}
			</p>
		</div>
	);
}
