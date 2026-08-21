"use client";

import { IconDeviceLaptop } from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import { useId, useMemo } from "react";
import { createMap } from "svg-dotted-map";
import { cn } from "@/lib/utils";

interface HostPin {
	id: string;
	name: string;
	location: { lat: number; lng: number };
}

const HOSTS: HostPin[] = [
	{
		id: "mac-host",
		name: "Mac host",
		location: { lat: 40.7128, lng: -99.006 },
	},
	{
		id: "linux-host",
		name: "Linux host",
		location: { lat: 51.5074, lng: -0.1278 },
	},
	{
		id: "remote-host",
		name: "Remote host",
		location: { lat: 35.6762, lng: 80.6503 },
	},
];

function latLngToPosition(
	lat: number,
	lng: number,
	width: number,
	height: number,
) {
	const x = ((lng + 180) / 360) * width;
	const latRad = (lat * Math.PI) / 180;
	const mercN = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
	const y = height / 2 - (mercN * width) / (2 * Math.PI);

	return { x, y };
}

export function RemoteWorldMap({
	className,
	dotRadius = 0.22,
	width = 120,
	height = 60,
	mapSamples = 6000,
}: {
	className?: string;
	dotRadius?: number;
	width?: number;
	height?: number;
	mapSamples?: number;
}) {
	const { points, xStep, yToRowIndex } = useMemo(() => {
		const { points } = createMap({ width, height, mapSamples });
		const sorted = [...points].sort((a, b) => a.y - b.y || a.x - b.x);
		const rowMap = new Map<number, number>();
		let step = 0;
		let previousY = Number.NaN;
		let previousXInRow = Number.NaN;

		for (const point of sorted) {
			if (point.y !== previousY) {
				previousY = point.y;
				previousXInRow = Number.NaN;
				if (!rowMap.has(point.y)) rowMap.set(point.y, rowMap.size);
			}
			if (!Number.isNaN(previousXInRow)) {
				const delta = point.x - previousXInRow;
				if (delta > 0) step = step === 0 ? delta : Math.min(step, delta);
			}
			previousXInRow = point.x;
		}

		return { points, xStep: step || 1, yToRowIndex: rowMap };
	}, [height, mapSamples, width]);

	const hostPositions = useMemo(
		() =>
			HOSTS.map((host) => ({
				...host,
				...latLngToPosition(
					host.location.lat,
					host.location.lng,
					width,
					height,
				),
			})),
		[height, width],
	);

	return (
		<div
			className={cn(
				"relative mx-auto w-full max-w-4xl mask-radial-from-50% mask-t-from-90%",
				className,
			)}
		>
			<svg
				role="presentation"
				viewBox={`0 0 ${width} ${height}`}
				className="h-auto w-full text-neutral-300 dark:text-neutral-700"
				aria-hidden="true"
			>
				{points.map((point) => {
					const rowIndex = yToRowIndex.get(point.y) ?? 0;
					const offsetX = rowIndex % 2 === 1 ? xStep / 2 : 0;
					return (
						<circle
							cx={point.x + offsetX}
							cy={point.y}
							r={dotRadius}
							fill="currentColor"
							key={`${point.x}-${point.y}`}
						/>
					);
				})}
			</svg>

			{hostPositions.map((host, index) => (
				<ComputerPin
					key={host.id}
					x={Number(((host.x / width) * 100).toFixed(3))}
					y={Number(((host.y / height) * 100).toFixed(3))}
					name={host.name}
					delay={index * 0.1}
				/>
			))}
		</div>
	);
}

function ComputerPin({
	x,
	y,
	name,
	delay,
}: {
	x: number;
	y: number;
	name: string;
	delay: number;
}) {
	const pinId = useId();
	const reduceMotion = useReducedMotion();

	return (
		<motion.div
			className="absolute z-10"
			style={{
				left: `${x}%`,
				top: `${y}%`,
				transform: "translate(-50%, -100%)",
			}}
			initial={reduceMotion ? false : { opacity: 0, y: 10, scale: 0.8 }}
			animate={{ opacity: 1, y: 0, scale: 1 }}
			transition={{
				duration: reduceMotion ? 0 : 0.5,
				delay: reduceMotion ? 0 : 0.3 + delay,
				ease: [0.23, 1, 0.32, 1],
			}}
		>
			<motion.div
				className="group relative cursor-default"
				whileHover={reduceMotion ? undefined : { scale: 1.1, y: -2 }}
				transition={{ duration: reduceMotion ? 0 : 0.2 }}
			>
				<svg
					width="40"
					height="50"
					viewBox="0 0 40 50"
					fill="none"
					className="size-12 drop-shadow-sm"
					aria-labelledby={pinId}
					role="img"
				>
					<title id={pinId}>{name}</title>
					<path
						d="M20 49C20 49 38 30 38 18C38 8.059 29.941 0 20 0C10.059 0 2 8.059 2 18C2 30 20 49 20 49Z"
						className="fill-white stroke-black/10 dark:fill-neutral-800 dark:stroke-white/20"
						strokeWidth="1"
					/>
					<circle
						cx="20"
						cy="18"
						r="15"
						className="fill-white dark:fill-neutral-800"
					/>
				</svg>
				<span className="text-heading pointer-events-none absolute top-[9px] left-1/2 grid size-6 -translate-x-1/2 place-items-center">
					<IconDeviceLaptop className="size-4" strokeWidth={1.75} />
				</span>
				<span className="bg-heading text-background pointer-events-none absolute top-full left-1/2 mt-1 -translate-x-1/2 rounded-md px-2 py-1 text-xs font-medium whitespace-nowrap opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100">
					{name}
				</span>
			</motion.div>
		</motion.div>
	);
}
