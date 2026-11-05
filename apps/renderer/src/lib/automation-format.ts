import "@zuse/i18n/english/automations";
import type {
	Automation,
	AutomationConfig,
	AutomationRun,
	AutomationTrigger,
} from "@zuse/contracts";
import { message as automationMessage, formatDate } from "@zuse/i18n";

export type AutomationTriggerKind = AutomationTrigger["_tag"];
type GithubTrigger = Extract<AutomationTrigger, { _tag: "github" }>;
type SlackTrigger = Extract<AutomationTrigger, { _tag: "slack" }>;
type ScheduleTrigger = Extract<AutomationTrigger, { _tag: "schedule" }>;
export type GithubEvent = GithubTrigger["events"][number];
export type SlackEvent = SlackTrigger["events"][number];

export const automationTriggerLabels = (): Readonly<
	Record<AutomationTriggerKind, string>
> => ({
	schedule: automationMessage("automations:schedule"),
	github: automationMessage("automations:github"),
	slack: automationMessage("automations:slack"),
	webhook: automationMessage("automations:webhook"),
	security_scan: automationMessage("automations:security_scan"),
	snapshot_build: automationMessage("automations:snapshot_build"),
	manual: automationMessage("automations:manual"),
});

export const githubEventOptions = (): ReadonlyArray<
	readonly [GithubEvent, string]
> => [
	["issue_comment", automationMessage("automations:issue_comment")],
	["issues", automationMessage("automations:issue")],
	["pull_request", automationMessage("automations:pull_request")],
	["pull_request_review", automationMessage("automations:pr_review")],
	[
		"pull_request_review_comment",
		automationMessage("automations:pr_review_comment"),
	],
	["check_run", automationMessage("automations:check_run")],
	["push", automationMessage("automations:push")],
];

export const slackEventOptions = (): ReadonlyArray<
	readonly [SlackEvent, string]
> => [
	["mention", automationMessage("automations:mentions")],
	["message", automationMessage("automations:channel_messages")],
	["reaction", automationMessage("automations:reactions")],
];

export const automationActionMeta = (): Readonly<
	Record<
		AutomationConfig["action"],
		{ readonly label: string; readonly description: string }
	>
> => ({
	new_session: {
		label: automationMessage("automations:start_new_session"),
		description: automationMessage(
			"automations:start_a_fresh_session_for_every_trigger",
		),
	},
	existing_session: {
		label: automationMessage("automations:message_existing_session"),
		description: automationMessage(
			"automations:send_each_trigger_to_one_ongoing_session",
		),
	},
	auto_triage: {
		label: automationMessage("automations:auto_triage"),
		description: automationMessage(
			"automations:triage_incoming_slack_messages_and_reply_in_thread",
		),
	},
	code_scan: {
		label: automationMessage("automations:code_scan"),
		description: automationMessage(
			"automations:start_a_fresh_read_only_code_scan_for_every_trigger",
		),
	},
});

export const automationRateWindows = (): ReadonlyArray<
	readonly [number, string]
> => [
	[60, automationMessage("automations:minute")],
	[3600, automationMessage("automations:hour")],
	[86400, automationMessage("automations:day")],
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

export const automationScheduleKinds = (): ReadonlyArray<
	readonly [ScheduleKind, string]
> => [
	["hourly", automationMessage("automations:every_hour")],
	["daily", automationMessage("automations:every_day")],
	["weekly", automationMessage("automations:every_week")],
	["once", automationMessage("automations:run_once")],
	["custom", automationMessage("automations:custom_schedule")],
];

export const automationWeekdays = () =>
	[
		automationMessage("automations:sunday"),
		automationMessage("automations:monday"),
		automationMessage("automations:tuesday"),
		automationMessage("automations:wednesday"),
		automationMessage("automations:thursday"),
		automationMessage("automations:friday"),
		automationMessage("automations:saturday"),
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
		return automationMessage("automations:once_on", {
			time: shortDateTime(trigger.onceAt),
		});
	if (form.kind === "hourly")
		return automationMessage("automations:hourly_at", {
			minute: pad(form.minute),
		});
	if (form.kind === "daily")
		return automationMessage("automations:daily_at", {
			time: formatClock(form.hour, form.minute),
			zone,
		});
	if (form.kind === "weekly")
		return automationMessage("automations:weekly_at", {
			day: automationWeekdays()[form.weekday] ?? "",
			time: formatClock(form.hour, form.minute),
			zone,
		});
	return automationMessage("automations:custom_cron", {
		cron: trigger.cron,
		zone,
	});
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
		case "github": {
			const events = labelsFor(trigger.events, githubEventOptions());
			return trigger.repositories.length
				? automationMessage("automations:events_in_repositories", {
						events,
						repositories: trigger.repositories.join(", "),
					})
				: events;
		}
		case "slack": {
			const events = labelsFor(trigger.events, slackEventOptions());
			return trigger.channelIds.length
				? automationMessage("automations:events_in_channels", {
						events,
						count: trigger.channelIds.length,
					})
				: events;
		}
		case "webhook":
		case "security_scan":
		case "snapshot_build":
			return automationMessage("automations:incoming_events");
		case "manual":
			return automationMessage("automations:started_by_hand");
	}
}

export function describeTrigger(trigger: AutomationTrigger): string {
	switch (trigger._tag) {
		case "schedule":
			return describeSchedule(trigger);
		case "github":
		case "slack":
			return automationMessage("automations:trigger_summary", {
				trigger: automationTriggerLabels()[trigger._tag],
				detail: triggerDetail(trigger).toLowerCase(),
			});
		case "webhook":
			return automationMessage("automations:webhook_events");
		case "security_scan":
			return automationMessage("automations:security_scan_events");
		case "snapshot_build":
			return automationMessage("automations:snapshot_build_events");
		case "manual":
			return automationMessage("automations:manual_runs_only");
	}
}

// ── Runs ─────────────────────────────────────────────────────────────────

export type RunTone = "success" | "error" | "info" | "outline" | "warning";
export const automationRunStatuses = (): Readonly<
	Record<AutomationRun["status"], { readonly label: string; tone: RunTone }>
> => ({
	queued: { label: automationMessage("automations:queued"), tone: "outline" },
	running: { label: automationMessage("automations:running"), tone: "info" },
	completed: {
		label: automationMessage("automations:completed"),
		tone: "success",
	},
	failed: { label: automationMessage("automations:failed"), tone: "error" },
	cancelled: {
		label: automationMessage("automations:cancelled"),
		tone: "outline",
	},
	cancelling: {
		label: automationMessage("automations:cancelling"),
		tone: "warning",
	},
	skipped: { label: automationMessage("automations:skipped"), tone: "outline" },
});
export const runIsActive = (run: AutomationRun) =>
	run.status === "queued" ||
	run.status === "running" ||
	run.status === "cancelling";

const automationRunSources = (): Readonly<Record<string, string>> => ({
	manual: automationMessage("automations:manual_run"),
	schedule: automationMessage("automations:schedule"),
	github: automationMessage("automations:github_event"),
	slack: automationMessage("automations:slack_event"),
	webhook: automationMessage("automations:webhook"),
	security_scan: automationMessage("automations:security_scan"),
	snapshot_build: automationMessage("automations:snapshot_build"),
});
export const runSourceLabel = (source: string): string =>
	automationRunSources()[source] ?? source.replaceAll("_", " ");

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
