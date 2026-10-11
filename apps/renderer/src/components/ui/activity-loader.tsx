import { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "~/hooks/use-media-query";
import {
	ACTIVITY_LOADER_STILL_TIME,
	type ActivityLoaderScene,
	drawActivityLoaderScene,
} from "~/lib/activity-loader-scenes";
import { cn } from "~/lib/utils";

type ActivityLoaderProps = {
	readonly scene: ActivityLoaderScene;
	/** Square CSS size in pixels. */
	readonly size: number;
	/** Accessible name; omit when adjacent text already describes the activity. */
	readonly label?: string;
	readonly className?: string;
};

/** Colour is re-read at this cadence so hover and theme changes follow. */
const COLOR_REFRESH_MS = 250;
const MIN_PIXEL_RATIO = 2;

type LoaderInstance = {
	readonly canvas: HTMLCanvasElement;
	readonly ctx: CanvasRenderingContext2D;
	scene: ActivityLoaderScene;
	size: number;
	pixelRatio: number;
	color: string;
	colorReadAt: number;
	visible: boolean;
};

/**
 * One animation frame loop drives every mounted loader. It stops entirely when
 * nothing visible is mounted; Chromium already suspends it for hidden windows.
 */
const instances = new Set<LoaderInstance>();
let frameRequest: number | null = null;
let clockOrigin: number | null = null;

function drawInstance(instance: LoaderInstance, time: number): void {
	if (time - instance.colorReadAt > COLOR_REFRESH_MS) {
		instance.color = getComputedStyle(instance.canvas).color;
		instance.colorReadAt = time;
	}
	drawActivityLoaderScene(instance.ctx, instance.scene, {
		time,
		size: instance.size,
		pixelRatio: instance.pixelRatio,
		color: instance.color,
	});
}

function tick(now: number): void {
	frameRequest = null;
	clockOrigin ??= now;
	const time = now - clockOrigin + ACTIVITY_LOADER_STILL_TIME;
	let anyVisible = false;
	for (const instance of instances) {
		if (!instance.visible) continue;
		anyVisible = true;
		drawInstance(instance, time);
	}
	if (anyVisible) frameRequest = requestAnimationFrame(tick);
}

function ensureRunning(): void {
	if (frameRequest !== null) return;
	frameRequest = requestAnimationFrame(tick);
}

/**
 * Square canvas loader that inherits `currentColor`. Reduced motion renders a
 * single still frame; offscreen loaders stop drawing until they scroll back.
 */
export function ActivityLoader({
	scene,
	size,
	label,
	className,
}: ActivityLoaderProps): React.ReactElement {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const reducedMotion = usePrefersReducedMotion();

	useEffect(() => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx) return;
		const pixelRatio = Math.max(
			MIN_PIXEL_RATIO,
			Math.ceil(window.devicePixelRatio || 1),
		);
		canvas.width = canvas.height = Math.round(size * pixelRatio);
		const instance: LoaderInstance = {
			canvas,
			ctx,
			scene,
			size,
			pixelRatio,
			color: getComputedStyle(canvas).color,
			colorReadAt: 0,
			visible: true,
		};

		if (reducedMotion) {
			drawInstance(instance, ACTIVITY_LOADER_STILL_TIME);
			return;
		}

		instances.add(instance);
		const observer =
			typeof IntersectionObserver === "undefined"
				? null
				: new IntersectionObserver(([entry]) => {
						instance.visible = entry?.isIntersecting ?? true;
						if (instance.visible) ensureRunning();
					});
		observer?.observe(canvas);
		ensureRunning();
		return () => {
			observer?.disconnect();
			instances.delete(instance);
		};
	}, [reducedMotion, scene, size]);

	// Callers own any live region; the loader itself is only an image.
	return (
		<canvas
			ref={canvasRef}
			role={label ? "img" : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : true}
			className={cn("block shrink-0", className)}
			style={{ width: size, height: size }}
			data-activity-loader={scene}
		/>
	);
}
