import { Cron } from "effect";

type ScheduleTrigger = {
	readonly cron: string;
	readonly timezone: string;
	readonly onceAt?: string;
};
const schedules = new Map<string, Cron.Cron>();

const parseSchedule = (trigger: ScheduleTrigger): Cron.Cron => {
	const key = `${trigger.timezone}\n${trigger.cron}`;
	const cached = schedules.get(key);
	if (cached) return cached;
	if (trigger.cron.trim().split(/\s+/u).length !== 5) {
		throw new Error(
			"Use a five-field cron expression (minute hour day month weekday).",
		);
	}
	const cron = Cron.parseUnsafe(trigger.cron, trigger.timezone);
	if (schedules.size >= 256) schedules.clear();
	schedules.set(key, cron);
	return cron;
};

const onceDate = (value: string): Date => {
	if (
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
			value,
		)
	) {
		throw new Error(
			"Run-once time must be an ISO timestamp with a timezone offset.",
		);
	}
	const date = new Date(value);
	const datePart = value.slice(0, 10);
	const calendarDate = new Date(`${datePart}T00:00:00Z`);
	if (
		!Number.isFinite(calendarDate.getTime()) ||
		calendarDate.toISOString().slice(0, 10) !== datePart ||
		Number(value.slice(11, 13)) > 23 ||
		Number(value.slice(14, 16)) > 59 ||
		!Number.isFinite(date.getTime())
	)
		throw new Error("Invalid run-once time.");
	return date;
};

/** Validate without using the wall clock, so saved schedules survive restarts. */
export const validateSchedule = (trigger: ScheduleTrigger): void => {
	if (trigger.onceAt !== undefined) {
		onceDate(trigger.onceAt);
		new Intl.DateTimeFormat("en", { timeZone: trigger.timezone });
		return;
	}
	// Detect impossible calendar expressions at validation, not in the worker loop.
	Cron.next(parseSchedule(trigger), new Date("2024-01-01T00:00:00Z"));
};

/** Strictly after `after`; persisted occurrences therefore never run twice. */
export const nextScheduledAt = (
	trigger: ScheduleTrigger,
	after: Date,
): Date | null => {
	if (!Number.isFinite(after.getTime()))
		throw new Error("Invalid schedule cursor.");
	if (trigger.onceAt !== undefined) {
		const date = onceDate(trigger.onceAt);
		return date.getTime() > after.getTime() ? date : null;
	}
	return Cron.next(parseSchedule(trigger), after);
};
