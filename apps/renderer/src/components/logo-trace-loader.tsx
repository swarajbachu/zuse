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

type LoaderPhase = "loop" | "closingTrace" | "fadingFill" | "done";

const CLOSING_TRACE_SECONDS = 0.28;
const TIMER_GRACE_MS = 80;

const positiveDuration = (value: number, fallback: number): number =>
	Number.isFinite(value) && value > 0 ? value : fallback;

/**
 * Draws the Z-shaped centerline while work is pending, then fills the real
 * Zuse contour. Both geometries live with the canonical desktop icon data so
 * the startup mark cannot drift back to an unrelated logo.
 */
export function LogoTraceLoader({
	loading = true,
	isComplete = false,
	size = 72,
	strokeWidth = 54,
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
		complete ? "closingTrace" : "loop",
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
		setPhase("closingTrace");
	}, [complete, phase]);

	useEffect(() => {
		if (phase !== "closingTrace") return;
		const timeout = window.setTimeout(
			() => setPhase("fadingFill"),
			CLOSING_TRACE_SECONDS * 1_000 + TIMER_GRACE_MS,
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
	const traceAnimation =
		phase === "loop"
			? `logo-trace-loader-loop ${loopSeconds}s ease-in-out infinite`
			: phase === "closingTrace"
				? `logo-trace-loader-close ${CLOSING_TRACE_SECONDS}s ease-out forwards`
				: null;

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
			<g opacity="0.12" transform={zuseMark.transform}>
				<path d={zuseMark.path} fill="currentColor" />
			</g>
			<path
				d={zuseMark.tracePath}
				fill="none"
				opacity="0.22"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={strokeWidth}
			/>

			{traceAnimation ? (
				<path
					data-logo-trace-path=""
					d={zuseMark.tracePath}
					fill="none"
					onAnimationEnd={
						phase === "closingTrace" ? () => setPhase("fadingFill") : undefined
					}
					pathLength={1}
					stroke="currentColor"
					strokeDasharray="1"
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={strokeWidth}
					style={{ animation: traceAnimation }}
				/>
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
