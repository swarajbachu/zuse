"use client";
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
	return (
		<Container as="section" id="product" className="py-10 md:py-20 lg:py-32">
			<Heading as="h2">Browser verification, built in</Heading>
			<Subheading className="mt-2">
				Let an agent drive a real browser and verify the flow inside Zuse
			</Subheading>
			<div className="mx-auto mt-8 grid grid-cols-1 gap-4 md:mt-12 md:grid-cols-3 md:grid-rows-2">
				<Card className="md:row-span-2">
					<CardContent className="flex h-full flex-col">
						<CardHeader>
							<CardTitle>Import browser sessions</CardTitle>
							<CardDescription>
								Copy valid cookies from a local browser profile into Zuse's
								built-in browser. Passwords are never imported.
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
							<CardTitle>Drive the whole flow</CardTitle>
							<CardDescription>
								Navigate, fill forms, click controls, and inspect the resulting
								page state.
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
							<CardTitle>Watch browser actions live</CardTitle>
							<CardDescription>
								See the page as the agent works and keep screenshots and results
								in the thread.
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
							<CardTitle>Describe what to verify</CardTitle>
							<CardDescription>
								Give the agent the flow and expected result; it performs the
								browser actions for you.
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
					title="Signed-in sessions"
					description="Copy valid cookies from a local browser profile. Passwords are never imported."
				/>
				<FeatureCard
					icon={<Monitor className="group-hover:text-primary size-5" />}
					title="A real, headless browser"
					description="Tests drive an actual browser — clicks, typing, navigation, and assertions."
				/>
				<FeatureCard
					icon={<RefreshCw className="group-hover:text-primary size-5" />}
					title="Inspect and retry"
					description="The agent can inspect the current page state, adjust the implementation, and try the flow again."
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
