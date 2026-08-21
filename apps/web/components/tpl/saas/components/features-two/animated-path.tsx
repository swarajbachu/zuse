"use client";

import { motion, useReducedMotion } from "motion/react";
import { useId } from "react";

export function AnimatedBeamPathIllustration({
	delay = 0,
}: {
	delay?: number;
}) {
	const path = "M 0 40 L 100 40 L 200 15 L 400 15 L 500 40 L 600 40";
	const id = useId();
	const reduceMotion = useReducedMotion();
	const fadeMaskId = `fadeMask-${id}`;
	const beamGradientId = `beamGradient-${id}`;
	const glowId = `glow-${id}`;
	const fadeEndsMaskId = `fadeEndsMask-${id}`;
	const beamFadeGradientId = `beamFadeGradient-${id}`;
	const beamMaskId = `beamMask-${id}`;
	const transition = {
		duration: 2,
		repeat: reduceMotion ? 0 : Number.POSITIVE_INFINITY,
		ease: "linear" as const,
		repeatDelay: 1,
		delay,
	};

	return (
		<div className="flex h-full w-full shrink-0 items-center justify-center overflow-visible [--beam-color:color-mix(in_oklab,var(--color-primary)_72%,var(--color-foreground))] [--path-color:color-mix(in_oklab,var(--color-foreground)_24%,transparent)]">
			<svg
				role="presentation"
				className="h-12 w-full"
				viewBox="0 0 600 80"
				fill="none"
				preserveAspectRatio="none"
				aria-hidden="true"
			>
				<defs>
					<linearGradient id={fadeMaskId} x1="0%" y1="0%" x2="100%" y2="0%">
						<stop offset="0%" stopColor="white" />
						<stop offset="100%" stopColor="white" />
					</linearGradient>
					<linearGradient id={beamGradientId} x1="0%" y1="0%" x2="100%" y2="0%">
						<stop offset="0%" stopColor="transparent" />
						<stop offset="30%" stopColor="var(--beam-color)" />
						<stop offset="50%" stopColor="var(--beam-color)" />
						<stop offset="70%" stopColor="var(--beam-color)" />
						<stop offset="100%" stopColor="transparent" />
					</linearGradient>
					<filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
						<feGaussianBlur stdDeviation="4" result="coloredBlur" />
						<feMerge>
							<feMergeNode in="coloredBlur" />
							<feMergeNode in="SourceGraphic" />
						</feMerge>
					</filter>
					<mask id={fadeEndsMaskId}>
						<rect width="600" height="80" fill={`url(#${fadeMaskId})`} />
					</mask>
					<linearGradient
						id={beamFadeGradientId}
						gradientUnits="userSpaceOnUse"
						x1="0"
						y1="0"
						x2="600"
						y2="0"
					>
						<motion.stop
							offset="0%"
							stopColor="black"
							animate={reduceMotion ? undefined : { offset: ["-25%", "100%"] }}
							transition={transition}
						/>
						<motion.stop
							offset="5%"
							stopColor="white"
							animate={reduceMotion ? undefined : { offset: ["-20%", "105%"] }}
							transition={transition}
						/>
						<motion.stop
							offset="15%"
							stopColor="white"
							animate={reduceMotion ? undefined : { offset: ["-10%", "115%"] }}
							transition={transition}
						/>
						<motion.stop
							offset="20%"
							stopColor="black"
							animate={reduceMotion ? undefined : { offset: ["-5%", "120%"] }}
							transition={transition}
						/>
					</linearGradient>
					<mask id={beamMaskId}>
						<path
							d={path}
							stroke={`url(#${beamFadeGradientId})`}
							strokeWidth="6"
							strokeLinecap="round"
							fill="none"
						/>
					</mask>
				</defs>
				<g mask={`url(#${fadeEndsMaskId})`}>
					<path
						d={path}
						stroke="var(--path-color)"
						strokeWidth="2"
						strokeDasharray="1 6"
						strokeLinecap="round"
					/>
					<g filter={`url(#${glowId})`}>
						<path
							d={path}
							stroke={`url(#${beamGradientId})`}
							strokeWidth="3"
							strokeLinecap="round"
							strokeDasharray="1 6"
							mask={`url(#${beamMaskId})`}
						/>
					</g>
				</g>
			</svg>
		</div>
	);
}
