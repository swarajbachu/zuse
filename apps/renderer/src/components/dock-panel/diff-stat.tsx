import { formatNumber } from "@zuse/i18n";
import { cn } from "~/lib/utils";

/** `+12 −3` line counts in the shared diff colors. */
export function DiffStat({
	additions,
	deletions,
	className,
}: {
	additions: number;
	deletions: number;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums",
				className,
			)}
		>
			<span className="text-[var(--accent-green)]">
				+{formatNumber(additions)}
			</span>
			<span className="text-[var(--accent-red)]">
				−{formatNumber(deletions)}
			</span>
		</span>
	);
}
