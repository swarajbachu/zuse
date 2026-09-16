import zuseMark from "@repo/ui/zuse-mark";
import { useEffect, useRef, useState } from "react";

export type LogoTraceLoaderProps = {
	readonly loading?: boolean;
	readonly isComplete?: boolean;
	readonly size?: number;
	readonly strokeWidth?: number;
	readonly loopDurationSeconds?: number;
	readonly fillFadeSeconds?: number;
	readonly className?: string;
	readonly ariaLabel?: string;
	readonly onDone?: () => void;
};

type LoaderPhase = "loop" | "closingOutline" | "fadingFill" | "done";

const CLOSING_OUTLINE_SECONDS = 0.28;
const TIMER_GRACE_MS = 80;

const positiveDuration = (value: number, fallback: number): number =>
	Number.isFinite(value) && value > 0 ? value : fallback;

/**
 * Traces the real Zuse mark while work is pending, then closes and fills it.
 * Outline and fill share the canonical contour used to generate the desktop
 * SVG, so the startup mark cannot drift from the product icon again.
 */
export function LogoTraceLoader({
	loading = true,
	isComplete = false,
	size = 72,
	strokeWidth = 42,
	loopDurationSeconds = 1.35,
	fillFadeSeconds = 0.24,
	className,
	ariaLabel = "Loading",
	onDone,
}: LogoTraceLoaderProps) {
	const complete = isComplete || !loading;
	const loopSeconds = positiveDuration(loopDurationSeconds, 1.35);
	const fadeSeconds = positiveDuration(fillFadeSeconds, 0.24);
	const [phase, setPhase] = useState<LoaderPhase>(() =>
		complete ? "closingOutline" : "loop",
	);
	const onDoneRef = useRef(onDone);
	const doneCalledRef = useRef(false);
	onDoneRef.current = onDone;

	const finish = () => {
		setPhase("done");
		if (doneCalledRef.current) return;
		doneCalledRef.current = true;
		onDoneRef.current?.();
	};

	useEffect(() => {
		const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
		if (!media?.matches) return;
		finish();
	}, []);

	useEffect(() => {
		if (!complete || phase !== "loop") return;
		setPhase("closingOutline");
	}, [complete, phase]);

	useEffect(() => {
		if (phase !== "closingOutline") return;
		const timeout = window.setTimeout(
			() => setPhase("fadingFill"),
			CLOSING_OUTLINE_SECONDS * 1_000 + TIMER_GRACE_MS,
		);
		return () => window.clearTimeout(timeout);
	}, [phase]);

	useEffect(() => {
		if (phase !== "fadingFill") return;
		const timeout = window.setTimeout(
			finish,
			fadeSeconds * 1_000 + TIMER_GRACE_MS,
		);
		return () => window.clearTimeout(timeout);
	}, [fadeSeconds, phase]);

	const showFill = phase === "fadingFill" || phase === "done";

	return (
		<svg
			aria-label={ariaLabel}
			className={className}
			data-logo-trace-loader=""
			height={size}
			role="status"
			viewBox={zuseMark.viewBox}
			width={size}
		>
			<g opacity="0.18" transform={zuseMark.transform}>
				<path
					d={zuseMark.path}
					fill="none"
					stroke="currentColor"
					strokeLinejoin="round"
					strokeWidth={Math.max(1, strokeWidth / 2)}
					vectorEffect="non-scaling-stroke"
				/>
			</g>

			{phase === "loop" ? (
				<g transform={zuseMark.transform}>
					<path
						d={zuseMark.path}
						fill="none"
						pathLength={1}
						stroke="currentColor"
						strokeDasharray="0.16 0.84"
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={strokeWidth}
						style={{
							animation: `logo-trace-loader-loop ${loopSeconds}s linear infinite`,
						}}
						vectorEffect="non-scaling-stroke"
					/>
				</g>
			) : null}

			{phase === "closingOutline" ? (
				<g transform={zuseMark.transform}>
					<path
						d={zuseMark.path}
						fill="none"
						onAnimationEnd={() => setPhase("fadingFill")}
						pathLength={1}
						stroke="currentColor"
						strokeDasharray="1"
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={strokeWidth}
						style={{
							animation: `logo-trace-loader-close ${CLOSING_OUTLINE_SECONDS}s ease-out forwards`,
						}}
						vectorEffect="non-scaling-stroke"
					/>
				</g>
			) : null}

			{showFill ? (
				<g
					onAnimationEnd={finish}
					transform={zuseMark.transform}
					style={
						phase === "fadingFill"
							? {
									animation: `logo-trace-loader-fill ${fadeSeconds}s ease-out forwards`,
								}
							: undefined
					}
				>
					<path d={zuseMark.path} fill="currentColor" />
				</g>
			) : null}
		</svg>
	);
}
