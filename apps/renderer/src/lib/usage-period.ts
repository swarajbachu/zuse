export type UsagePeriod = "7d" | "30d" | "90d";

const PERIOD_DAYS: Record<UsagePeriod, number> = {
	"7d": 7,
	"30d": 30,
	"90d": 90,
};

export const sinceForUsagePeriod = (
	period: UsagePeriod,
	now = Date.now(),
): Date => new Date(now - PERIOD_DAYS[period] * 86_400_000);
