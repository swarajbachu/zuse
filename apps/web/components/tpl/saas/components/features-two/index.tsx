"use client";
import { useWebsiteMessages } from "@zuse/i18n/website/react";
import { CalendarDays } from "lucide-react";
import { motion } from "motion/react";
import type React from "react";
import { Button } from "@/components/button";
import { Container } from "../container";
import { Heading } from "../heading";
import { AnimatedBeamPathIllustration } from "./animated-path";
import { IPhoneSkeleton } from "./iphone-skeleton";
import { MacbookSkeleton } from "./macbook-skeleton";
import { ServerHardware } from "./server-hardware";

export function FeaturesTwo() {
	const { message: t } = useWebsiteMessages();

	return (
		<Container className="px-4 py-10 md:py-20 lg:py-28">
			<div className="mx-auto mb-16 max-w-2xl text-center">
				<Heading as="h2" className="mb-4">
					{t("showcase:keep_agent_work_moving_anywhere")}
				</Heading>
			</div>

			<div className="relative mx-auto mb-8 hidden h-12 w-full items-center lg:flex">
				{["16.666%", "50%", "83.333%"].map((left) => (
					<div
						key={left}
						className="absolute top-1/2 z-10 -translate-x-1/2 -translate-y-1/2"
						style={{ left }}
					>
						<BeamCircle />
					</div>
				))}
				{["16.666%", "50%"].map((left, index) => (
					<div
						key={left}
						className="absolute top-1/2 w-1/3 -translate-y-1/2"
						style={{ left }}
					>
						<AnimatedBeamPathIllustration delay={index * 1.4} />
					</div>
				))}
			</div>

			<div className="mx-auto grid w-full grid-cols-1 items-start gap-16 overflow-hidden py-4 lg:grid-cols-3 lg:gap-20 lg:py-10">
				<FeatureItem>
					<IPhoneSkeleton />
					<FeatureTitle>{t("showcase:agents_in_your_pocket")}</FeatureTitle>
					<Status>{t("showcase:coming_soon")}</Status>
				</FeatureItem>
				<FeatureItem>
					<MacbookSkeleton />
					<FeatureTitle>{t("showcase:full_control_at_your_desk")}</FeatureTitle>
					<Status live>{t("showcase:available_now")}</Status>
				</FeatureItem>
				<FeatureItem>
					<ServerSkeleton />
					<FeatureTitle>{t("showcase:agents_that_keep_running")}</FeatureTitle>
					<Status>{t("showcase:cloud_beta")}</Status>
				</FeatureItem>
			</div>

			<div
				id="cloud-interest"
				className="border-border/60 -mx-4 md:-mx-8 mt-14 grid scroll-mt-24 gap-6 border-t px-4 pt-8 md:px-8 md:grid-cols-[1fr_auto] md:items-center"
			>
				<div>
					<p className="text-primary font-mono text-[10px] font-semibold tracking-wide uppercase">
						{t("showcase:cloud_beta")}
					</p>
					<h3 className="text-heading mt-2 text-3xl font-light tracking-tight">
						{t("showcase:interested_in_a_hosted_workspace")}
					</h3>
				</div>
				<Button
					href="https://cal.com/swaraj/15min"
					text={t("showcase:book_a_call")}
					icon={<CalendarDays aria-hidden="true" className="size-4 shrink-0" />}
					containerClassName="justify-center min-w-40"
				/>
			</div>
		</Container>
	);
}

function FeatureItem({ children }: { children: React.ReactNode }) {
	return (
		<motion.div
			whileHover="animate"
			initial="initial"
			className="flex min-w-0 flex-col items-center"
		>
			{children}
		</motion.div>
	);
}
function BeamCircle() {
	return (
		<div className="bg-elevated flex size-4 shrink-0 items-center justify-center rounded-full">
			<div className="bg-primary size-2 rounded-full" />
		</div>
	);
}
function FeatureTitle({ children }: { children: React.ReactNode }) {
	return (
		<h3 className="text-heading mt-6 text-center text-3xl font-light">
			{children}
		</h3>
	);
}
function Status({
	children,
	live = false,
}: {
	children: React.ReactNode;
	live?: boolean;
}) {
	return (
		<p
			className={
				live
					? "text-primary mt-1 font-mono text-[10px] font-medium uppercase"
					: "text-muted-foreground mt-1 font-mono text-[10px] font-medium uppercase"
			}
		>
			{children}
		</p>
	);
}
function ServerSkeleton() {
	return (
		<motion.div
			variants={{
				initial: { opacity: 0.7, y: 6 },
				animate: { opacity: 1, y: -4 },
			}}
			transition={{ duration: 0.3, ease: "easeOut" }}
			className="relative flex h-44 w-60 items-center justify-center"
		>
			<div className="bg-primary/15 absolute h-28 w-40 rounded-full blur-3xl" />
			<ServerHardware className="relative w-60" />
		</motion.div>
	);
}
