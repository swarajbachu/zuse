"use client";

import {
	type ButtonHTMLAttributes,
	forwardRef,
	type HTMLAttributes,
	useEffect,
	useImperativeHandle,
	useRef,
} from "react";

type Rgb = readonly [red: number, green: number, blue: number];

const BAYER_8 = [
	0, 48, 12, 60, 3, 51, 15, 63, 32, 16, 44, 28, 35, 19, 47, 31, 8, 56, 4, 52,
	11, 59, 7, 55, 40, 24, 36, 20, 43, 27, 39, 23, 2, 50, 14, 62, 1, 49, 13, 61,
	34, 18, 46, 30, 33, 17, 45, 29, 10, 58, 6, 54, 9, 57, 5, 53, 42, 26, 38, 22,
	41, 25, 37, 21,
] as const;

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

export type DitherButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
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
		const canvasRef = useRef<HTMLCanvasElement>(null);
		const [red, green, blue] = color;
		useImperativeHandle(
			forwardedRef,
			() => buttonRef.current as HTMLButtonElement,
		);

		useEffect(() => {
			const button = buttonRef.current;
			const canvas = canvasRef.current;
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
							? 0.86 - 0.62 * ((y + 0.5) / rows)
							: variant === "dotted"
								? 0.54
								: 0.76;
					for (let x = 0; x < columns; x += 1) {
						if (variant === "hatched" && ((x + y) & 3) >= 2) continue;
						const lit =
							variant === "solid" ||
							density >
								(BAYER_4[(y & 3) * 4 + (x & 3)] ?? 0) - intensity * 0.07;
						if (variant === "dotted" && !lit) continue;
						context.fillStyle = rgb(
							paintColor,
							clamp(
								(lit ? 0.28 + density * 0.52 : 0.08 + density * 0.12) *
									(1 + intensity * 0.12),
							),
						);
						context.fillRect(x, y, 1, 1);
					}
				}
			};
			const tick = () => {
				const delta = target - intensity;
				if (Math.abs(delta) < 0.01) {
					intensity = target;
					paint();
					frame = 0;
					return;
				}
				intensity += delta * 0.22;
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
			const down = () => setTarget(1.2);
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
			<button
				ref={buttonRef}
				type={type}
				className={`relative isolate overflow-hidden rounded-md outline-none transition-opacity pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 ${className ?? ""}`}
				{...props}
			>
				<canvas
					ref={canvasRef}
					className="absolute inset-0 -z-10 size-full"
					style={{ imageRendering: "pixelated" }}
				/>
				<span className="relative flex size-full items-center justify-center">
					{children}
				</span>
			</button>
		);
	},
);

export type DitherWaveBackgroundProps = Omit<
	HTMLAttributes<HTMLDivElement>,
	"color"
> & {
	color?: Rgb;
	pixelSize?: number;
	waveSpeed?: number;
	waveFrequency?: number;
	waveAmplitude?: number;
	colorNum?: number;
	disableAnimation?: boolean;
	enableMouseInteraction?: boolean;
	mouseRadius?: number;
};

/**
 * A transparent, bottom-weighted ordered-dither field for landing surfaces.
 * It keeps the supplied shader's layered wave and Bayer quantization, but uses
 * a tiny 2D canvas so an idle composer does not keep a WebGL scene alive.
 */
export function DitherWaveBackground({
	color = [151, 183, 76],
	pixelSize = 3,
	waveSpeed = 0.045,
	waveFrequency = 3,
	waveAmplitude = 0.28,
	colorNum = 4,
	disableAnimation = true,
	enableMouseInteraction = false,
	mouseRadius = 0.28,
	className,
	style,
	...props
}: DitherWaveBackgroundProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		const host = canvas?.parentElement;
		const context = canvas?.getContext("2d", { alpha: true });
		if (!canvas || !host || !context) return;

		const reducedMotion = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;
		const shouldAnimate = !disableAnimation && !reducedMotion;
		let columns = 0;
		let rows = 0;
		let frame = 0;
		let startedAt = performance.now();
		let lastPaint = 0;
		const mouse = { x: -2, y: -2 };

		const resize = () => {
			const box = host.getBoundingClientRect();
			columns = Math.max(1, Math.ceil(box.width / pixelSize));
			rows = Math.max(1, Math.ceil(box.height / pixelSize));
			canvas.width = columns;
			canvas.height = rows;
			canvas.style.width = `${box.width}px`;
			canvas.style.height = `${box.height}px`;
			paint(performance.now());
		};

		const paint = (now: number) => {
			const image = context.createImageData(columns, rows);
			const pixels = image.data;
			const time = ((now - startedAt) / 1000) * waveSpeed;
			for (let y = 0; y < rows; y += 1) {
				const vertical = (y + 0.5) / rows;
				for (let x = 0; x < columns; x += 1) {
					const horizontal = (x + 0.5) / columns;
					const aspect = columns / Math.max(rows, 1);
					const px = (horizontal - 0.5) * aspect;
					const py = vertical - 0.5;
					const octaveA = Math.sin((px * waveFrequency + time) * Math.PI * 2);
					const octaveB = Math.sin(
						(px * waveFrequency * 1.73 - py * 4.2 - time * 1.3) * Math.PI,
					);
					const octaveC = Math.cos(
						(px * waveFrequency * 0.63 + py * 7.4 + time * 0.7) * Math.PI,
					);
					let wave = (octaveA + octaveB * 0.55 + octaveC * 0.25) / 1.8;
					wave *= waveAmplitude;

					if (enableMouseInteraction) {
						const distance = Math.hypot(
							horizontal - mouse.x,
							vertical - mouse.y,
						);
						wave += clamp(1 - distance / mouseRadius) * 0.22;
					}

					const bottomFade = clamp((vertical - 0.08) / 0.78);
					const edgeFade = clamp(1 - Math.abs(horizontal - 0.5) * 1.35);
					const density = clamp(bottomFade * edgeFade + wave - 0.14);
					const threshold = (BAYER_8[(y & 7) * 8 + (x & 7)] ?? 0) / 64;
					if (density <= threshold) continue;

					const levels = Math.max(2, colorNum) - 1;
					const alpha = Math.round(clamp(density) * levels) / levels;
					const offset = (y * columns + x) * 4;
					pixels[offset] = color[0];
					pixels[offset + 1] = color[1];
					pixels[offset + 2] = color[2];
					pixels[offset + 3] = Math.round(alpha * 0.58 * 255);
				}
			}
			context.putImageData(image, 0, 0);
		};

		const tick = (now: number) => {
			if (now - lastPaint > 32) {
				paint(now);
				lastPaint = now;
			}
			frame = window.requestAnimationFrame(tick);
		};

		const onPointerMove = (event: PointerEvent) => {
			const box = host.getBoundingClientRect();
			mouse.x = (event.clientX - box.left) / Math.max(box.width, 1);
			mouse.y = (event.clientY - box.top) / Math.max(box.height, 1);
		};
		const observer = new ResizeObserver(resize);
		observer.observe(host);
		if (enableMouseInteraction)
			window.addEventListener("pointermove", onPointerMove);
		resize();
		if (shouldAnimate) frame = window.requestAnimationFrame(tick);

		return () => {
			observer.disconnect();
			window.cancelAnimationFrame(frame);
			window.removeEventListener("pointermove", onPointerMove);
			startedAt = 0;
		};
	}, [
		color[0],
		color[1],
		color[2],
		pixelSize,
		waveSpeed,
		waveFrequency,
		waveAmplitude,
		colorNum,
		disableAnimation,
		enableMouseInteraction,
		mouseRadius,
	]);

	return (
		<div
			aria-hidden="true"
			className={className}
			style={{ pointerEvents: "none", ...style }}
			{...props}
		>
			<canvas
				ref={canvasRef}
				style={{
					display: "block",
					height: "100%",
					imageRendering: "pixelated",
					width: "100%",
				}}
			/>
		</div>
	);
}
