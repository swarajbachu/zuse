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

const LOGO_VIEW_BOX = "0 0 1024 1024";
const TRACE_PATH = "M 240 720 L 240 320 L 432 560 L 624 320 L 624 720";
const FILL_PATHS = [
	"M 240 720 L 240 320 L 432 560 L 624 320 L 624 720",
	"M 728 720 L 784 720",
] as const;

const CLOSING_OUTLINE_SECONDS = 0.28;
const TIMER_GRACE_MS = 80;

const positiveDuration = (value: number, fallback: number): number =>
	Number.isFinite(value) && value > 0 ? value : fallback;

/**
 * Traces the real Zuse mark while work is pending, then closes and fills it.
 * The source logo is stroke-based, so the final layer retains its exact round
 * caps and joins instead of approximating the mark with a derived contour.
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
			viewBox={LOGO_VIEW_BOX}
			width={size}
		>
			<g opacity="0.18">
				<path
					d={TRACE_PATH}
					fill="none"
					stroke="currentColor"
					strokeLinejoin="round"
					strokeWidth={Math.max(1, strokeWidth / 2)}
				/>
			</g>

			{phase === "loop" ? (
				<path
					d={TRACE_PATH}
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
				/>
			) : null}

			{phase === "closingOutline" ? (
				<path
					d={TRACE_PATH}
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
				/>
			) : null}

			{showFill ? (
				<g
					onAnimationEnd={finish}
					style={
						phase === "fadingFill"
							? {
									animation: `logo-trace-loader-fill ${fadeSeconds}s ease-out forwards`,
								}
							: undefined
					}
				>
					{FILL_PATHS.map((path) => (
						<path
							d={path}
							fill="none"
							key={path}
							stroke="currentColor"
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={80}
						/>
					))}
				</g>
			) : null}
		</svg>
	);
}
