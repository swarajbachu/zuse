"use client";

import {
	type ButtonHTMLAttributes,
	forwardRef,
	useEffect,
	useImperativeHandle,
	useRef,
} from "react";

type Rgb = readonly [red: number, green: number, blue: number];

const clamp = (value: number) => Math.max(0, Math.min(1, value));

const BAYER_4 = [
	0 / 16,
	8 / 16,
	2 / 16,
	10 / 16,
	12 / 16,
	4 / 16,
	14 / 16,
	6 / 16,
	3 / 16,
	11 / 16,
	1 / 16,
	9 / 16,
	15 / 16,
	7 / 16,
	13 / 16,
	5 / 16,
] as const;

const rgb = (color: Rgb, alpha: number) =>
	`rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;

const hashName = (value: string) => {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
};

const randomFrom = (seed: number) => {
	let state = seed || 0x9e3779b9;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x1_0000_0000;
	};
};

const hueToRgb = (hue: number): Rgb => {
	const chroma = 0.72;
	const lightness = 0.62;
	const sector = (((hue % 360) + 360) % 360) / 60;
	const x = chroma * (1 - Math.abs((sector % 2) - 1));
	const [red, green, blue] =
		sector < 1
			? [chroma, x, 0]
			: sector < 2
				? [x, chroma, 0]
				: sector < 3
					? [0, chroma, x]
					: sector < 4
						? [0, x, chroma]
						: sector < 5
							? [x, 0, chroma]
							: [chroma, 0, x];
	const match = lightness - chroma / 2;
	return [
		Math.round((red + match) * 255),
		Math.round((green + match) * 255),
		Math.round((blue + match) * 255),
	];
};

export type DitherAvatarProps = {
	name: string;
	hue?: number;
	size?: number;
	className?: string;
	animate?: boolean;
};

/** Deterministic mirrored pixel avatar adapted from Dither Kit's avatar. */
export function DitherAvatar({
	name,
	hue,
	size = 24,
	className,
	animate = false,
}: DitherAvatarProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		const context = canvas?.getContext("2d");
		if (!canvas || !context) return;
		const grid = 8;
		const cell = 4;
		canvas.width = grid * cell;
		canvas.height = grid * cell;
		const random = randomFrom(hashName(name));
		const enabled = Array.from({ length: 32 }, () => random() > 0.46);
		const densities = Array.from({ length: 32 }, () => 0.58 + random() * 0.4);
		const color = hueToRgb(hue ?? Math.floor(random() * 180) * 2);
		const reduced = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;
		let frame = 0;
		const startedAt = performance.now();

		const paint = (progress: number) => {
			context.clearRect(0, 0, canvas.width, canvas.height);
			for (let row = 0; row < grid; row += 1) {
				for (let column = 0; column < grid; column += 1) {
					const folded = row * 4 + Math.min(column, 7 - column);
					if (!enabled[folded]) continue;
					const density = densities[folded] ?? 0.7;
					const reveal = clamp(
						(progress - (BAYER_4[(row & 3) * 4 + (column & 3)] ?? 0) * 0.7) /
							0.3,
					);
					for (let pixelY = 0; pixelY < cell; pixelY += 1) {
						for (let pixelX = 0; pixelX < cell; pixelX += 1) {
							const x = column * cell + pixelX;
							const y = row * cell + pixelY;
							const lit = density > (BAYER_4[(y & 3) * 4 + (x & 3)] ?? 0);
							context.fillStyle = rgb(
								color,
								(lit ? density : density * 0.3) * reveal,
							);
							context.fillRect(x, y, 1, 1);
						}
					}
				}
			}
		};

		if (!animate || reduced) {
			paint(1);
			return;
		}
		const tick = (now: number) => {
			const progress = clamp((now - startedAt) / 600);
			paint(1 - (1 - progress) ** 3);
			if (progress < 1) frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [animate, hue, name]);

	return (
		<span
			role="img"
			aria-label={`${name} avatar`}
			className={`relative block shrink-0 overflow-hidden rounded-[4px] ${className ?? ""}`}
			style={{ height: size, width: size }}
		>
			<canvas
				ref={canvasRef}
				className="absolute inset-0 size-full"
				style={{ imageRendering: "pixelated" }}
			/>
		</span>
	);
}

export type DitherButtonProps = Omit<
	ButtonHTMLAttributes<HTMLButtonElement>,
	"color"
> & {
	color?: Rgb;
	variant?: "gradient" | "dotted" | "hatched" | "solid";
};

/** Native button with the kit's low-resolution ordered-dither fill. */
export const DitherButton = forwardRef<HTMLButtonElement, DitherButtonProps>(
	function DitherButton(
		{
			color = [151, 183, 76],
			variant = "gradient",
			className,
			children,
			type = "button",
			...props
		},
		forwardedRef,
	) {
		const buttonRef = useRef<HTMLButtonElement>(null);
		useImperativeHandle(
			forwardedRef,
			() => buttonRef.current as HTMLButtonElement,
		);

		return (
			<button
				ref={buttonRef}
				type={type}
				className={`relative isolate overflow-hidden rounded-md outline-none transition-opacity pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 ${className ?? ""}`}
				{...props}
			>
				<DitherButtonBackground color={color} variant={variant} />
				<span className="relative flex size-full items-center justify-center">
					{children}
				</span>
			</button>
		);
	},
);

/** Dither Kit's button painter, shared by native buttons and navigation links.
 * Adapted from https://tripwire.sh/r/button.json (2px cells, bottom-up fill).
 * The parent must be positioned, isolated, and clip its overflow.
 */
export function DitherButtonBackground({
	color = [151, 183, 76],
	variant = "gradient",
}: Pick<DitherButtonProps, "color" | "variant">) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [red, green, blue] = color;

	useEffect(() => {
		const canvas = canvasRef.current;
		const button = canvas?.parentElement;
		const context = canvas?.getContext("2d");
		if (!button || !canvas || !context) return;
		let columns = 0;
		let rows = 0;
		let intensity = 0;
		let target = 0;
		let hovered = false;
		let frame = 0;
		const reduced = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;
		const paintColor: Rgb = [red, green, blue];

		const paint = () => {
			context.clearRect(0, 0, columns, rows);
			for (let y = 0; y < rows; y += 1) {
				const density =
					variant === "gradient"
						? 0.25 + 0.75 * ((y + 0.5) / rows)
						: variant === "dotted"
							? 0.5
							: 0.75;
				for (let x = 0; x < columns; x += 1) {
					if (variant === "hatched" && ((x + y) & 3) >= 2) continue;
					const lit =
						variant === "solid" ||
						density >
							(BAYER_4[(y & 3) * 4 + (x & 3)] ?? 0) +
								0.5 / 16 -
								intensity * 0.1 -
								(variant === "dotted" ? 0.12 : 0);
					if (variant === "dotted" && !lit) continue;
					context.fillStyle = rgb(
						paintColor,
						clamp(
							(0.3 + density * 0.7) * (lit ? 1 : 0.4) * (1 + intensity * 0.22),
						),
					);
					context.fillRect(x, y, 1, 1);
				}
			}
			context.fillStyle = rgb(paintColor, clamp(0.5 + 0.25 * intensity));
			context.fillRect(0, 0, columns, 1);
			context.fillRect(0, rows - 1, columns, 1);
			context.fillRect(0, 0, 1, rows);
			context.fillRect(columns - 1, 0, 1, rows);
		};
		const tick = () => {
			const delta = target - intensity;
			if (Math.abs(delta) < 0.01) {
				intensity = target;
				paint();
				frame = 0;
				return;
			}
			intensity += delta * 0.16;
			paint();
			frame = requestAnimationFrame(tick);
		};
		const setTarget = (next: number) => {
			target = next;
			if (reduced) {
				intensity = next;
				paint();
			} else if (!frame) frame = requestAnimationFrame(tick);
		};
		const resize = () => {
			const box = button.getBoundingClientRect();
			columns = Math.max(4, Math.round(box.width / 2));
			rows = Math.max(4, Math.round(box.height / 2));
			canvas.width = columns;
			canvas.height = rows;
			paint();
		};
		const enter = (event: PointerEvent) => {
			if (event.pointerType === "touch") return;
			hovered = true;
			setTarget(1);
		};
		const leave = () => {
			hovered = false;
			setTarget(0);
		};
		const down = () => setTarget(1.5);
		const up = () => setTarget(hovered ? 1 : 0);
		const observer = new ResizeObserver(resize);
		observer.observe(button);
		button.addEventListener("pointerenter", enter);
		button.addEventListener("pointerleave", leave);
		button.addEventListener("pointerdown", down);
		button.addEventListener("pointerup", up);
		button.addEventListener("pointercancel", up);
		resize();
		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
			button.removeEventListener("pointerenter", enter);
			button.removeEventListener("pointerleave", leave);
			button.removeEventListener("pointerdown", down);
			button.removeEventListener("pointerup", up);
			button.removeEventListener("pointercancel", up);
		};
	}, [blue, green, red, variant]);

	return (
		<canvas
			ref={canvasRef}
			tabIndex={-1}
			aria-hidden="true"
			style={{
				position: "absolute",
				inset: 0,
				zIndex: -1,
				width: "100%",
				height: "100%",
				pointerEvents: "none",
				imageRendering: "pixelated",
			}}
		/>
	);
}
