export const usagePace = (
	usedPercent: number | null,
	resetsAt: string | null,
	windowMinutes: number | null,
	now = Date.now(),
): { reserve: number; label: string; tone: "reserve" | "over" } | null => {
	if (usedPercent === null || !resetsAt || !windowMinutes) return null;
	const end = Date.parse(resetsAt);
	const duration = windowMinutes * 60_000;
	const elapsed = duration - (end - now);
	if (!Number.isFinite(end) || elapsed < duration * 0.03 || elapsed > duration)
		return null;
	const reserve = (elapsed / duration) * 100 - usedPercent;
	const rounded = Math.round(Math.abs(reserve));
	return reserve >= 0
		? { reserve, label: `+${rounded}% in reserve`, tone: "reserve" }
		: { reserve, label: `${rounded}% over pace`, tone: "over" };
};
