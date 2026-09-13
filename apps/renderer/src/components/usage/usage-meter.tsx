import { formatNumber, formatDate as formatUiDate } from "@zuse/i18n";
import { cn } from "~/lib/utils";

export const resetLabel = (iso: string | null): string | null => {
	if (!iso) return null;
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return null;
	const now = new Date();
	const sameDay = date.toDateString() === now.toDateString();
	return formatUiDate(date, {
		hour: "2-digit",
		minute: "2-digit",
		...(!sameDay ? ({ day: "numeric", month: "short" } as const) : {}),
	});
};

export const resetsInLabel = (
	iso: string | null,
	now = Date.now(),
): string | null => {
	if (!iso) return null;
	const remaining = Date.parse(iso) - now;
	if (!Number.isFinite(remaining) || remaining <= 0) return null;
	const minutes = Math.floor(remaining / 60_000);
	const unit = (value: number, name: string, minimumIntegerDigits = 1) =>
		formatNumber(value, {
			style: "unit",
			unit: name,
			unitDisplay: "narrow",
			minimumIntegerDigits,
		});
	if (minutes < 60) return unit(minutes, "minute");
	const hours = Math.floor(minutes / 60);
	if (hours < 24)
		return `${unit(hours, "hour")} ${unit(minutes % 60, "minute", 2)}`;
	return `${unit(Math.floor(hours / 24), "day")} ${unit(hours % 24, "hour")}`;
};

export function StickMeter({
	percent,
	tone = "default",
}: {
	readonly percent: number | null;
	readonly tone?: "default" | "warning";
}) {
	const segments = 38;
	const clamped = percent === null ? 0 : Math.min(Math.max(percent, 0), 100);
	const filled = percent === null ? 0 : Math.ceil((clamped / 100) * segments);
	return (
		<div
			className="grid h-4 grid-cols-[repeat(38,minmax(0,1fr))] gap-0.5"
			aria-hidden
		>
			{Array.from({ length: segments }, (_, index) => (
				<div
					key={index}
					className={cn(
						"rounded-[2px] transition-colors motion-reduce:transition-none",
						index < filled
							? tone === "warning"
								? "bg-amber-300/65"
								: "bg-primary/70"
							: "bg-muted-foreground/16",
					)}
				/>
			))}
		</div>
	);
}
