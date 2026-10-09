import { HugeiconsIcon } from "@hugeicons/react";
import type { GitPrCheckRun } from "@zuse/contracts";
import {
	CancelCircleIcon,
	CheckmarkCircle02Icon,
} from "@zuse/icons/solid-rounded";
import { cn } from "~/lib/utils";
import {
	type CheckCounts,
	type CheckKind,
	checkKind,
} from "../../lib/pr-checks.ts";
import { Spinner } from "../ui/spinner.tsx";

export const CHECK_KIND_TEXT_CLASS: Record<CheckKind, string> = {
	failure: "text-[var(--accent-red)]",
	pending: "text-[var(--accent-amber)]",
	success: "text-[var(--accent-green)]",
	neutral: "text-muted-foreground/60",
};

function DashedCircle({ className }: { className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn("grid size-3.5 shrink-0 place-items-center", className)}
		>
			<span className="size-3 rounded-full border border-dashed border-current" />
		</span>
	);
}

/** One status glyph per check run, shared by every check list. */
export function CheckStatusIcon({
	run,
	className = "size-3.5",
}: {
	run: GitPrCheckRun;
	className?: string;
}) {
	const kind = checkKind(run);
	const tone = CHECK_KIND_TEXT_CLASS[kind];
	if (kind === "pending") {
		return run.status === "queued" || run.status === "pending" ? (
			<DashedCircle className={cn(className, tone)} />
		) : (
			<Spinner className={cn("shrink-0", className, tone)} />
		);
	}
	if (kind === "neutral")
		return <DashedCircle className={cn(className, tone)} />;
	return (
		<HugeiconsIcon
			icon={kind === "success" ? CheckmarkCircle02Icon : CancelCircleIcon}
			className={cn("shrink-0", className, tone)}
		/>
	);
}

const RING_RADIUS = 6.25;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const RING_GAP = 1.5;
const RING_ORDER: readonly CheckKind[] = [
	"success",
	"failure",
	"pending",
	"neutral",
];

/** Proportional rollup of check outcomes, read clockwise from 12 o'clock. */
export function ChecksRing({
	counts,
	className,
}: {
	counts: CheckCounts;
	className?: string;
}) {
	const present = RING_ORDER.filter((kind) => counts[kind] > 0);
	const gap = present.length > 1 ? RING_GAP : 0;
	let offset = 0;
	return (
		<svg
			viewBox="0 0 16 16"
			aria-hidden="true"
			className={cn("size-3.5 shrink-0 -rotate-90", className)}
		>
			{counts.total === 0 ? (
				<circle
					cx={8}
					cy={8}
					r={RING_RADIUS}
					fill="none"
					strokeWidth={2.2}
					strokeDasharray="2 2"
					className="stroke-current text-muted-foreground/50"
				/>
			) : (
				present.map((kind) => {
					const span = (counts[kind] / counts.total) * RING_CIRCUMFERENCE;
					const length = Math.max(0.5, span - gap);
					const start = offset;
					offset += span;
					return (
						<circle
							key={kind}
							cx={8}
							cy={8}
							r={RING_RADIUS}
							fill="none"
							strokeWidth={2.2}
							strokeDasharray={`${length} ${RING_CIRCUMFERENCE - length}`}
							strokeDashoffset={-start}
							className={cn("stroke-current", CHECK_KIND_TEXT_CLASS[kind])}
						/>
					);
				})
			)}
		</svg>
	);
}
