"use client";

import { motion } from "motion/react";
import type React from "react";
import { WaitlistForm } from "@/components/cloud-teaser/waitlist-form";
import { Container } from "../container";
import { Heading } from "../heading";
import { Subheading } from "../subheading";
import { AnimatedBeamPathIllustration } from "./animated-path";
import { IPhoneSkeleton } from "./iphone-skeleton";
import { MacbookSkeleton } from "./macbook-skeleton";
import { ServerHardware } from "./server-hardware";

export function FeaturesTwo() {
	return (
		<Container className="px-4 py-10 md:py-20 lg:py-28">
			<div className="mx-auto mb-16 max-w-2xl text-center">
				<Heading as="h2" className="mb-4">
					Deploy agents across every platform
				</Heading>
				<Subheading className="text-balance">
					Run agents from desktop today, persistent cloud workspaces in beta,
					and a mobile companion coming soon.
				</Subheading>
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
					<FeatureTitle>Agents in your pocket</FeatureTitle>
					<Status>Coming soon</Status>
					<FeatureDescription>
						Follow runs and approve decisions from your phone.
					</FeatureDescription>
				</FeatureItem>
				<FeatureItem>
					<MacbookSkeleton />
					<FeatureTitle>Full control at your desk</FeatureTitle>
					<Status live>Available now</Status>
					<FeatureDescription>
						Run agents, inspect changes, and manage worktrees in Zuse Desktop.
					</FeatureDescription>
				</FeatureItem>
				<FeatureItem>
					<ServerSkeleton />
					<FeatureTitle>Agents that keep running</FeatureTitle>
					<Status live>Live beta</Status>
					<FeatureDescription>
						Run isolated cloud workspaces even after your computer goes offline.
					</FeatureDescription>
				</FeatureItem>
			</div>

			<div
				id="cloud-interest"
				className="border-border mx-auto mt-14 grid max-w-4xl scroll-mt-24 gap-6 border-t pt-8 md:grid-cols-[1fr_360px] md:items-center"
			>
				<div>
					<p className="text-primary font-mono text-[10px] font-semibold tracking-wide uppercase">
						Cloud beta
					</p>
					<h3 className="text-heading mt-2 text-lg font-semibold tracking-tight">
						Interested in a hosted workspace?
					</h3>
					<p className="text-muted-foreground mt-1 max-w-md text-sm leading-6">
						Register your interest as we open beta capacity to more developers.
					</p>
				</div>
				<WaitlistForm />
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
		<h3 className="text-heading mt-6 text-center text-base font-medium">
			{children}
		</h3>
	);
}
function FeatureDescription({ children }: { children: React.ReactNode }) {
	return (
		<p className="text-muted-foreground mx-auto mt-2 max-w-xs text-center text-sm text-balance">
			{children}
		</p>
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
