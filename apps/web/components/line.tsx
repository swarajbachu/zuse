import React from "react";
import { cn } from "@/lib/utils";

type LineCommonProps = {
	className?: string;
	/** Center-to-center spacing between dots (px) */
	gap?: number;
	/** Dot radius (px) */
	dotRadius?: number;
};

export type HorizontalLineProps = LineCommonProps & {
	/** Pixel height of the SVG strip (pattern is vertically centered inside) */
	height?: number;
	fillClassName?: string;
};

export type VerticalLineProps = LineCommonProps & {
	/** Pixel width of the SVG strip */
	width?: number;
	fillClassName?: string;
};

// Dotted rules that frame the page and divide sections. The foreground tint
// keeps them equally legible on light and dark canvases.
export function HorizontalLine({
	className,
	gap = 8,
	dotRadius = 1,
	height: stripHeight = 4,
	fillClassName = "fill-foreground/18",
}: HorizontalLineProps) {
	const rawId = React.useId().replace(/:/g, "");
	const patternId = `h-dots-${rawId}`;
	const patternH = Math.max(dotRadius * 2 + 2, 4);
	const patternW = Math.max(gap, dotRadius * 2 + 2);

	return (
		<svg
			className={cn("pointer-events-none block w-full", className)}
			style={{ height: stripHeight }}
			xmlns="http://www.w3.org/2000/svg"
			preserveAspectRatio="none"
			role="presentation"
			aria-hidden="true"
		>
			<defs>
				<pattern
					id={patternId}
					width={patternW}
					height={patternH}
					patternUnits="userSpaceOnUse"
				>
					<circle
						cx={patternW / 2}
						cy={patternH / 2}
						r={dotRadius}
						className={fillClassName}
					/>
				</pattern>
			</defs>
			<rect width="100%" height="100%" fill={`url(#${patternId})`} />
		</svg>
	);
}

export function VerticalLine({
	className,
	gap = 8,
	dotRadius = 1,
	fillClassName = "fill-foreground/18",
	width: stripWidth = 4,
}: VerticalLineProps) {
	const rawId = React.useId().replace(/:/g, "");
	const patternId = `v-dots-${rawId}`;
	const patternW = Math.max(dotRadius * 2 + 2, 4);
	const patternH = Math.max(gap, dotRadius * 2 + 2);

	return (
		<svg
			className={cn(
				"pointer-events-none absolute top-0 bottom-0 left-0 z-20 block h-full",
				className,
			)}
			style={{ width: stripWidth }}
			xmlns="http://www.w3.org/2000/svg"
			preserveAspectRatio="none"
			role="presentation"
			aria-hidden="true"
		>
			<defs>
				<pattern
					id={patternId}
					width={patternW}
					height={patternH}
					patternUnits="userSpaceOnUse"
				>
					<circle
						cx={patternW / 2}
						cy={patternH / 2}
						r={dotRadius}
						className={fillClassName}
					/>
				</pattern>
			</defs>
			<rect width="100%" height="100%" fill={`url(#${patternId})`} />
		</svg>
	);
}
