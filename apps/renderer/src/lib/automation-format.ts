import type {
	Automation,
	AutomationConfig,
	AutomationRun,
	AutomationTrigger,
} from "@zuse/contracts";
import { formatDate } from "@zuse/i18n";

export type AutomationTriggerKind = AutomationTrigger["_tag"];
type GithubTrigger = Extract<AutomationTrigger, { _tag: "github" }>;
type SlackTrigger = Extract<AutomationTrigger, { _tag: "slack" }>;
type ScheduleTrigger = Extract<AutomationTrigger, { _tag: "schedule" }>;
export type GithubEvent = GithubTrigger["events"][number];
export type SlackEvent = SlackTrigger["events"][number];

export const TRIGGER_LABEL: Readonly<Record<AutomationTriggerKind, string>> = {
	schedule: "Schedule",
	github: "GitHub",
	slack: "Slack",
	webhook: "Webhook",
	security_scan: "Security scan",
	snapshot_build: "Snapshot build",
	manual: "Manual",
};

export const GITHUB_EVENTS: ReadonlyArray<readonly [GithubEvent, string]> = [
	["issue_comment", "Issue comment"],
	["issues", "Issue"],
	["pull_request", "Pull request"],
	["pull_request_review", "PR review"],
	["pull_request_review_comment", "PR review comment"],
	["check_run", "Check run"],
	["push", "Push"],
];

export const SLACK_EVENTS: ReadonlyArray<readonly [SlackEvent, string]> = [
	["mention", "Mentions"],
	["message", "Channel messages"],
	["reaction", "Reactions"],
];

export const ACTION_META: Readonly<
	Record<
		AutomationConfig["action"],
		{ readonly label: string; readonly description: string }
	>
> = {
	new_session: {
		label: "Start new session",
		description: "Start a fresh session for every trigger.",
	},
	existing_session: {
		label: "Message existing session",
		description: "Send each trigger to one ongoing session.",
	},
	auto_triage: {
		label: "Auto-triage",
		description: "Triage incoming Slack messages and reply in thread.",
	},
	code_scan: {
		label: "Code scan",
		description: "Start a fresh read-only code scan for every trigger.",
	},
};

export const RATE_WINDOWS: ReadonlyArray<readonly [number, string]> = [
	[60, "minute"],
	[3600, "hour"],
	[86400, "day"],
];

export const localTimezone = (): string =>
	Intl.DateTimeFormat().resolvedOptions().timeZone;

export function newAutomationTrigger(
	kind: AutomationTriggerKind,
): AutomationTrigger {
	if (kind === "schedule")
		return { _tag: kind, cron: "0 9 * * *", timezone: localTimezone() };
	if (kind === "github")
		return { _tag: kind, events: ["issues"], repositories: [], actions: [] };
	if (kind === "slack")
		return {
			_tag: kind,
			events: ["mention"],
			channelIds: [],
			keywords: [],
			includeBotMessages: false,
		};
	return { _tag: kind };
}

export const splitAutomationList = (value: string): string[] =>
	value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);

// ── Schedules ────────────────────────────────────────────────────────────

export type ScheduleKind = "hourly" | "daily" | "weekly" | "once" | "custom";

export const SCHEDULE_KINDS: ReadonlyArray<readonly [ScheduleKind, string]> = [
	["hourly", "Every hour"],
	["daily", "Every day"],
	["weekly", "Every week"],
	["once", "Run once"],
	["custom", "Custom schedule"],
];

export const WEEKDAYS = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
] as const;
const WEEKDAY_TOKENS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export interface ScheduleForm {
	readonly kind: ScheduleKind;
	readonly hour: number;
	readonly minute: number;
	readonly weekday: number;
}

const field = (value: string, max: number): number | null =>
	/^\d{1,2}$/u.test(value) && Number(value) <= max ? Number(value) : null;
const weekdayField = (value: string): number | null => {
	const named = WEEKDAY_TOKENS.indexOf(value.toUpperCase());
	if (named >= 0) return named;
	const day = field(value, 7);
	return day === null ? null : day % 7;
};

/** Recognise the presets the form can edit; anything else stays custom. */
export function scheduleForm(trigger: ScheduleTrigger): ScheduleForm {
	const fallback = { hour: 9, minute: 0, weekday: 1 };
	if (trigger.onceAt !== undefined) return { kind: "once", ...fallback };
	const parts = trigger.cron.trim().split(/\s+/u);
	if (parts.length === 5 && parts[2] === "*" && parts[3] === "*") {
		const minute = field(parts[0] ?? "", 59);
		if (minute !== null && parts[1] === "*" && parts[4] === "*")
			return { ...fallback, kind: "hourly", minute };
		const hour = field(parts[1] ?? "", 23);
		if (minute !== null && hour !== null) {
			if (parts[4] === "*") return { ...fallback, kind: "daily", hour, minute };
			const weekday = weekdayField(parts[4] ?? "");
			if (weekday !== null) return { kind: "weekly", hour, minute, weekday };
		}
	}
	return { kind: "custom", ...fallback };
}

/** The cron for a preset; `custom` and `once` keep the caller's own value. */
export function presetCron(form: ScheduleForm): string {
	if (form.kind === "hourly") return `${form.minute} * * * *`;
	if (form.kind === "weekly")
		return `${form.minute} ${form.hour} * * ${form.weekday}`;
	return `${form.minute} ${form.hour} * * *`;
}

const pad = (value: number) => String(value).padStart(2, "0");
export const formatClock = (hour: number, minute: number) =>
	`${pad(hour)}:${pad(minute)}`;

/** `<input type="datetime-local">` value for an absolute timestamp. */
export function toDateTimeLocal(iso: string): string {
	const date = new Date(iso);
	if (!Number.isFinite(date.getTime())) return "";
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function fromDateTimeLocal(value: string): string | null {
	const date = new Date(value);
	return value && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// ── Summaries ────────────────────────────────────────────────────────────

const shortDateTime = (value: string | Date) =>
	formatDate(typeof value === "string" ? new Date(value) : value, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});

export function describeSchedule(trigger: ScheduleTrigger): string {
	const form = scheduleForm(trigger);
	const zone =
		trigger.timezone === localTimezone() ? "" : ` (${trigger.timezone})`;
	if (form.kind === "once" && trigger.onceAt)
		return `Once on ${shortDateTime(trigger.onceAt)}`;
	if (form.kind === "hourly") return `Every hour at :${pad(form.minute)}`;
	if (form.kind === "daily")
		return `Every day at ${formatClock(form.hour, form.minute)}${zone}`;
	if (form.kind === "weekly")
		return `Every ${WEEKDAYS[form.weekday]} at ${formatClock(form.hour, form.minute)}${zone}`;
	return `Cron ${trigger.cron}${zone}`;
}

const labelsFor = <Value extends string>(
	values: ReadonlyArray<Value>,
	labels: ReadonlyArray<readonly [Value, string]>,
) =>
	values
		.map((value) => labels.find(([id]) => id === value)?.[1] ?? value)
		.join(", ");

/** Trigger summary without its family name, for places that already show it. */
export function triggerDetail(trigger: AutomationTrigger): string {
	switch (trigger._tag) {
		case "schedule":
			return describeSchedule(trigger);
		case "github":
			return `${labelsFor(trigger.events, GITHUB_EVENTS)}${
				trigger.repositories.length
					? ` in ${trigger.repositories.join(", ")}`
					: ""
			}`;
		case "slack":
			return `${labelsFor(trigger.events, SLACK_EVENTS)}${
				trigger.channelIds.length
					? ` in ${trigger.channelIds.length === 1 ? "1 channel" : `${trigger.channelIds.length} channels`}`
					: ""
			}`;
		case "webhook":
		case "security_scan":
		case "snapshot_build":
			return "Incoming events";
		case "manual":
			return "Started by hand";
	}
}

export function describeTrigger(trigger: AutomationTrigger): string {
	switch (trigger._tag) {
		case "schedule":
			return describeSchedule(trigger);
		case "github":
		case "slack":
			return `${TRIGGER_LABEL[trigger._tag]} ${triggerDetail(trigger).toLowerCase()}`;
		case "webhook":
			return "Webhook events";
		case "security_scan":
			return "Security scan events";
		case "snapshot_build":
			return "Snapshot build events";
		case "manual":
			return "Manual runs only";
	}
}

// ── Runs ─────────────────────────────────────────────────────────────────

export type RunTone = "success" | "error" | "info" | "outline" | "warning";
export const RUN_STATUS: Readonly<
	Record<AutomationRun["status"], { readonly label: string; tone: RunTone }>
> = {
	queued: { label: "Queued", tone: "outline" },
	running: { label: "Running", tone: "info" },
	completed: { label: "Completed", tone: "success" },
	failed: { label: "Failed", tone: "error" },
	cancelled: { label: "Cancelled", tone: "outline" },
	cancelling: { label: "Cancelling", tone: "warning" },
	skipped: { label: "Skipped", tone: "outline" },
};
export const runIsActive = (run: AutomationRun) =>
	run.status === "queued" ||
	run.status === "running" ||
	run.status === "cancelling";

const RUN_SOURCE: Readonly<Record<string, string>> = {
	manual: "Manual run",
	schedule: "Schedule",
	github: "GitHub event",
	slack: "Slack event",
	webhook: "Webhook",
	security_scan: "Security scan",
	snapshot_build: "Snapshot build",
};
export const runSourceLabel = (source: string): string =>
	RUN_SOURCE[source] ?? source.replaceAll("_", " ");

export function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.round(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60)
		return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
	return minutes % 60
		? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
		: `${Math.floor(minutes / 60)}h`;
}

export function runDuration(
	run: AutomationRun,
	now = Date.now(),
): string | null {
	if (!run.startedAt) return null;
	const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
	return formatDuration(end - Date.parse(run.startedAt));
}

export const formatAutomationTime = shortDateTime;

/** Mark agent-generated drafts so the library can surface them for review. */
export const AGENT_SOURCE_KEY = "zuse.source";
export const AGENT_SOURCE_VALUE = "agent";
export const isAgentDraft = (config: AutomationConfig) =>
	config.metadata[AGENT_SOURCE_KEY] === AGENT_SOURCE_VALUE;

// ── Library filters ──────────────────────────────────────────────────────

export type AutomationStatusFilter = "all" | "enabled" | "paused" | "drafts";

export function filterAutomations(
	records: ReadonlyArray<Automation>,
	query: string,
	status: AutomationStatusFilter,
	projectId: string | null,
): ReadonlyArray<Automation> {
	const search = query.trim().toLowerCase();
	return records.filter(
		({ config }) =>
			(!projectId || config.projectId === projectId) &&
			(status === "all" ||
				(status === "drafts"
					? isAgentDraft(config) && !config.enabled
					: config.enabled === (status === "enabled"))) &&
			(!search ||
				[
					config.name,
					config.description,
					config.prompt,
					...config.triggers.map(describeTrigger),
					...Object.entries(config.metadata).flat(),
				]
					.join(" ")
					.toLowerCase()
					.includes(search)),
	);
}
