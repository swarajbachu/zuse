import { HugeiconsIcon } from "@hugeicons/react";
import type { Automation, AutomationTrigger } from "@zuse/contracts";
import { Delete02Icon, PlusSignIcon } from "@zuse/icons/solid-rounded";
import {
	nextScheduledAt,
	validateSchedule,
} from "@zuse/utils/automation-schedule";
import { useId, useState } from "react";
import {
	type AutomationTriggerKind,
	describeTrigger,
	formatAutomationTime,
	fromDateTimeLocal,
	GITHUB_EVENTS,
	type GithubEvent,
	localTimezone,
	newAutomationTrigger,
	presetCron,
	SCHEDULE_KINDS,
	type ScheduleForm,
	type ScheduleKind,
	SLACK_EVENTS,
	type SlackEvent,
	scheduleForm,
	splitAutomationList,
	TRIGGER_LABEL,
	toDateTimeLocal,
	triggerDetail,
	WEEKDAYS,
} from "~/lib/automation-format.ts";
import { CopyButton } from "../copy-button.tsx";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuSub,
	MenuSubPopup,
	MenuSubTrigger,
	MenuTrigger,
} from "../ui/menu.tsx";
import { Switch } from "../ui/switch.tsx";
import {
	AutomationField,
	AutomationMultiSelect,
	AutomationNotice,
	AutomationSelect,
	numberInputClass,
	TriggerIcon,
} from "./automation-controls.tsx";

type ScheduleTrigger = Extract<AutomationTrigger, { _tag: "schedule" }>;

/** Schedule problems the server would reject; null when valid. */
export function scheduleError(trigger: AutomationTrigger): string | null {
	if (trigger._tag !== "schedule") return null;
	try {
		validateSchedule(trigger);
		return null;
	} catch (cause) {
		return cause instanceof Error ? cause.message : String(cause);
	}
}

const githubTrigger = (event: GithubEvent): AutomationTrigger => ({
	_tag: "github",
	events: [event],
	repositories: [],
	actions: [],
});
const slackTrigger = (event: SlackEvent): AutomationTrigger => ({
	...(newAutomationTrigger("slack") as Extract<
		AutomationTrigger,
		{ _tag: "slack" }
	>),
	events: [event],
});
const scheduleTrigger = (kind: ScheduleKind): AutomationTrigger => {
	const base = { _tag: "schedule" as const, timezone: localTimezone() };
	if (kind === "once")
		return {
			...base,
			cron: "0 9 * * *",
			onceAt: new Date(Date.now() + 3600000).toISOString(),
		};
	if (kind === "custom") return { ...base, cron: "30 9 * * 1-5" };
	return {
		...base,
		cron: presetCron({ kind, hour: 9, minute: 0, weekday: 1 }),
	};
};

const menuIcon = (kind: AutomationTriggerKind) => <TriggerIcon kind={kind} />;

/** Trigger families with their event or frequency choices, as in the add menu. */
export function AddTriggerMenu({
	onAdd,
	variant = "ghost",
}: {
	onAdd: (trigger: AutomationTrigger) => void;
	variant?: "outline" | "ghost";
}) {
	return (
		<Menu>
			<MenuTrigger
				render={
					<Button variant={variant} className="h-7 text-muted-foreground" />
				}
			>
				<HugeiconsIcon icon={PlusSignIcon} aria-hidden />
				Add
			</MenuTrigger>
			<MenuPopup align="end" className="w-52">
				<MenuSub>
					<MenuSubTrigger compact>
						{menuIcon("github")}
						GitHub
					</MenuSubTrigger>
					<MenuSubPopup className="w-48">
						{GITHUB_EVENTS.map(([event, label]) => (
							<MenuItem
								key={event}
								className="h-7"
								onClick={() => onAdd(githubTrigger(event))}
							>
								{label}
							</MenuItem>
						))}
					</MenuSubPopup>
				</MenuSub>
				<MenuSub>
					<MenuSubTrigger compact>
						{menuIcon("schedule")}
						Schedule
					</MenuSubTrigger>
					<MenuSubPopup className="w-44">
						{SCHEDULE_KINDS.map(([kind, label]) => (
							<MenuItem
								key={kind}
								className="h-7"
								onClick={() => onAdd(scheduleTrigger(kind))}
							>
								{label}
							</MenuItem>
						))}
					</MenuSubPopup>
				</MenuSub>
				<MenuSub>
					<MenuSubTrigger compact>
						{menuIcon("slack")}
						Slack
					</MenuSubTrigger>
					<MenuSubPopup className="w-44">
						{SLACK_EVENTS.map(([event, label]) => (
							<MenuItem
								key={event}
								className="h-7"
								onClick={() => onAdd(slackTrigger(event))}
							>
								{label}
							</MenuItem>
						))}
					</MenuSubPopup>
				</MenuSub>
				{(
					["webhook", "security_scan", "snapshot_build", "manual"] as const
				).map((kind) => (
					<MenuItem
						key={kind}
						className="h-7 gap-2"
						onClick={() => onAdd(newAutomationTrigger(kind))}
					>
						{menuIcon(kind)}
						{TRIGGER_LABEL[kind]}
					</MenuItem>
				))}
			</MenuPopup>
		</Menu>
	);
}

export function AutomationTriggerCard({
	trigger,
	index,
	webhook,
	saved,
	environment,
	onChange,
	onRemove,
}: {
	trigger: AutomationTrigger;
	index: number;
	webhook: Automation["webhook"];
	saved: boolean;
	/** Where the automation runs; hosted endpoints exist only in the cloud. */
	environment: "local" | "cloud" | null;
	onChange: (trigger: AutomationTrigger) => void;
	onRemove: () => void;
}) {
	return (
		<div className="rounded-lg bg-muted/30 px-3 pt-1.5 pb-3">
			<div className="flex h-8 items-center gap-2">
				<TriggerIcon
					kind={trigger._tag}
					className="size-3.5 shrink-0 text-muted-foreground"
				/>
				<p className="min-w-0 flex-1 truncate">
					<span className="font-medium">{TRIGGER_LABEL[trigger._tag]}</span>
					<span className="text-muted-foreground">
						{" "}
						· {triggerDetail(trigger)}
					</span>
				</p>
				<Button
					size="icon-sm"
					variant="ghost"
					className="-me-1.5 text-muted-foreground"
					aria-label={`Remove trigger ${index + 1}: ${describeTrigger(trigger)}`}
					onClick={onRemove}
				>
					<HugeiconsIcon icon={Delete02Icon} aria-hidden />
				</Button>
			</div>
			<div className="mt-1.5">
				<TriggerFields
					trigger={trigger}
					webhook={webhook}
					saved={saved}
					environment={environment}
					onChange={onChange}
				/>
			</div>
		</div>
	);
}

function TriggerFields({
	trigger,
	webhook,
	saved,
	environment,
	onChange,
}: {
	trigger: AutomationTrigger;
	webhook: Automation["webhook"];
	saved: boolean;
	environment: "local" | "cloud" | null;
	onChange: (trigger: AutomationTrigger) => void;
}) {
	const id = useId();
	switch (trigger._tag) {
		case "schedule":
			return <ScheduleFields trigger={trigger} onChange={onChange} />;
		case "github":
			return (
				<div className="grid gap-2.5">
					<div className="grid gap-2.5 sm:grid-cols-3">
						<AutomationField label="Events" htmlFor={`${id}-events`}>
							<AutomationMultiSelect
								id={`${id}-events`}
								label="Events"
								placeholder="Choose events"
								options={GITHUB_EVENTS}
								values={trigger.events}
								onChange={(events) => onChange({ ...trigger, events })}
							/>
						</AutomationField>
						<AutomationField label="Repositories" htmlFor={`${id}-repos`}>
							<ListInput
								id={`${id}-repos`}
								placeholder="All repositories"
								values={trigger.repositories}
								onChange={(repositories) =>
									onChange({ ...trigger, repositories })
								}
							/>
						</AutomationField>
						<AutomationField label="Actions" htmlFor={`${id}-actions`}>
							<ListInput
								id={`${id}-actions`}
								placeholder="All actions"
								values={trigger.actions}
								onChange={(actions) => onChange({ ...trigger, actions })}
							/>
						</AutomationField>
					</div>
					{trigger.events.length === 0 && (
						<AutomationNotice tone="error">
							Choose at least one event.
						</AutomationNotice>
					)}
				</div>
			);
		case "slack":
			return (
				<div className="grid gap-2.5">
					<div className="grid gap-2.5 sm:grid-cols-3">
						<AutomationField label="Events" htmlFor={`${id}-events`}>
							<AutomationMultiSelect
								id={`${id}-events`}
								label="Events"
								placeholder="Choose events"
								options={SLACK_EVENTS}
								values={trigger.events}
								onChange={(events) => onChange({ ...trigger, events })}
							/>
						</AutomationField>
						<AutomationField label="Channel IDs" htmlFor={`${id}-channels`}>
							<ListInput
								id={`${id}-channels`}
								placeholder="All channels"
								values={trigger.channelIds}
								onChange={(channelIds) => onChange({ ...trigger, channelIds })}
							/>
						</AutomationField>
						<AutomationField label="Keywords" htmlFor={`${id}-keywords`}>
							<ListInput
								id={`${id}-keywords`}
								placeholder="Any message"
								values={trigger.keywords}
								onChange={(keywords) => onChange({ ...trigger, keywords })}
							/>
						</AutomationField>
					</div>
					{trigger.events.length === 0 && (
						<AutomationNotice tone="error">
							Choose at least one event.
						</AutomationNotice>
					)}
					<div className="flex items-center justify-between gap-4">
						<label
							htmlFor={`${id}-bots`}
							className="text-xs"
							title="Messages from Zuse itself are always ignored to prevent loops."
						>
							Include other bots’ messages
						</label>
						<Switch
							id={`${id}-bots`}
							checked={trigger.includeBotMessages}
							onCheckedChange={(includeBotMessages) =>
								onChange({ ...trigger, includeBotMessages })
							}
						/>
					</div>
				</div>
			);
		case "manual":
			return (
				<p className="text-[11px] text-muted-foreground">
					Runs only when you start it, or from the Zuse CLI.
				</p>
			);
		default:
			return (
				<EndpointFields
					webhook={webhook}
					saved={saved}
					environment={environment}
				/>
			);
	}
}

function EndpointFields({
	webhook,
	saved,
	environment,
}: {
	webhook: Automation["webhook"];
	saved: boolean;
	environment: "local" | "cloud" | null;
}) {
	const id = useId();
	const [reveal, setReveal] = useState(false);
	if (!webhook)
		return (
			<p className="text-[11px] text-muted-foreground">
				{environment !== "cloud" ? (
					<>
						Send events with <code>zuse automation dispatch</code>. Hosted
						endpoints are available in cloud workspaces.
					</>
				) : saved ? (
					<>
						Endpoint pending. You can also send events with{" "}
						<code>zuse automation dispatch</code>.
					</>
				) : (
					"The endpoint URL and token appear after you create this."
				)}
			</p>
		);
	return (
		<div className="grid gap-1.5">
			<div className="flex items-center gap-1.5">
				<Input
					id={`${id}-url`}
					aria-label="Endpoint URL"
					className="h-7 flex-1 font-mono"
					readOnly
					value={webhook.url}
				/>
				<CopyButton
					text={webhook.url}
					label="Copy endpoint URL"
					className="size-7"
				/>
			</div>
			<div className="flex items-center gap-1.5">
				<Input
					id={`${id}-token`}
					aria-label="Bearer token"
					title="Keep this token private."
					className="h-7 flex-1 font-mono"
					type={reveal ? "text" : "password"}
					readOnly
					value={webhook.token}
				/>
				<Button
					variant="ghost"
					className="h-7"
					aria-pressed={reveal}
					onClick={() => setReveal((value) => !value)}
				>
					{reveal ? "Hide" : "Show"}
				</Button>
				<CopyButton
					text={webhook.token}
					label="Copy bearer token"
					className="size-7"
				/>
			</div>
		</div>
	);
}

/** Comma-separated values, committed on blur so typing a comma is not lost. */
function ListInput({
	id,
	values,
	onChange,
	placeholder,
}: {
	id: string;
	values: ReadonlyArray<string>;
	onChange: (values: string[]) => void;
	placeholder?: string;
}) {
	const joined = values.join(", ");
	const [draft, setDraft] = useState<string | null>(null);
	return (
		<Input
			id={id}
			className="h-7"
			placeholder={placeholder}
			value={draft ?? joined}
			onChange={(event) => setDraft(event.target.value)}
			onBlur={() => {
				if (draft === null) return;
				onChange(splitAutomationList(draft));
				setDraft(null);
			}}
		/>
	);
}

let timezoneOptions: ReadonlyArray<string> | null = null;
const timezones = () => {
	timezoneOptions ??= (() => {
		try {
			return Intl.supportedValuesOf("timeZone");
		} catch {
			return [localTimezone(), "UTC"];
		}
	})();
	return timezoneOptions;
};

function ScheduleFields({
	trigger,
	onChange,
}: {
	trigger: ScheduleTrigger;
	onChange: (trigger: AutomationTrigger) => void;
}) {
	const id = useId();
	const form = scheduleForm(trigger);
	const error = scheduleError(trigger);
	const update = (next: ScheduleForm) =>
		onChange({
			_tag: "schedule",
			timezone: trigger.timezone,
			cron: presetCron(next),
		});
	const setKind = (kind: ScheduleKind) => {
		if (kind === form.kind) return;
		if (kind === "once") {
			onChange({
				...trigger,
				onceAt: new Date(Date.now() + 3600000).toISOString(),
			});
			return;
		}
		if (kind === "custom") {
			onChange({
				_tag: "schedule",
				timezone: trigger.timezone,
				cron: form.kind === "once" ? "30 9 * * 1-5" : trigger.cron,
			});
			return;
		}
		update({ ...form, kind });
	};
	let next: Date | null = null;
	if (!error)
		try {
			next = nextScheduledAt(trigger, new Date());
		} catch {
			next = null;
		}
	return (
		<div className="grid gap-2">
			<div className="grid gap-2.5 sm:grid-cols-3">
				<AutomationField label="Frequency" htmlFor={`${id}-kind`}>
					<AutomationSelect
						id={`${id}-kind`}
						label="Frequency"
						value={form.kind}
						options={SCHEDULE_KINDS.map(([value, label]) => ({ value, label }))}
						onChange={setKind}
					/>
				</AutomationField>
				{form.kind === "weekly" && (
					<AutomationField label="Day" htmlFor={`${id}-day`}>
						<AutomationSelect
							id={`${id}-day`}
							label="Day"
							value={String(form.weekday)}
							options={WEEKDAYS.map((day, value) => ({
								value: String(value),
								label: day,
							}))}
							onChange={(value) => update({ ...form, weekday: Number(value) })}
						/>
					</AutomationField>
				)}
				{form.kind === "hourly" && (
					<AutomationField
						label="Minute past the hour"
						htmlFor={`${id}-minute`}
					>
						<Input
							id={`${id}-minute`}
							className={`h-7 ${numberInputClass}`}
							type="number"
							min={0}
							max={59}
							value={form.minute}
							onChange={(event) => {
								const minute = Number(event.target.value);
								if (Number.isInteger(minute) && minute >= 0 && minute <= 59)
									update({ ...form, minute });
							}}
						/>
					</AutomationField>
				)}
				{(form.kind === "daily" || form.kind === "weekly") && (
					<AutomationField label="Time" htmlFor={`${id}-time`}>
						<Input
							id={`${id}-time`}
							className="h-7"
							type="time"
							value={`${String(form.hour).padStart(2, "0")}:${String(form.minute).padStart(2, "0")}`}
							onChange={(event) => {
								const [hour, minute] = event.target.value
									.split(":")
									.map(Number);
								if (Number.isInteger(hour) && Number.isInteger(minute))
									update({ ...form, hour: hour ?? 0, minute: minute ?? 0 });
							}}
						/>
					</AutomationField>
				)}
				{form.kind === "once" && (
					<AutomationField label="Date and time" htmlFor={`${id}-once`}>
						<Input
							id={`${id}-once`}
							className="h-7"
							type="datetime-local"
							value={toDateTimeLocal(trigger.onceAt ?? "")}
							onChange={(event) => {
								const onceAt = fromDateTimeLocal(event.target.value);
								if (onceAt) onChange({ ...trigger, onceAt });
							}}
						/>
					</AutomationField>
				)}
				{form.kind === "custom" && (
					<AutomationField label="Cron expression" htmlFor={`${id}-cron`}>
						<Input
							id={`${id}-cron`}
							className="h-7 font-mono"
							placeholder="min hour day month weekday"
							title="Five fields: minute, hour, day of month, month, weekday"
							value={trigger.cron}
							aria-invalid={error ? true : undefined}
							onChange={(event) =>
								onChange({ ...trigger, cron: event.target.value })
							}
						/>
					</AutomationField>
				)}
				{form.kind !== "once" && (
					<AutomationField label="Timezone" htmlFor={`${id}-zone`}>
						<Input
							id={`${id}-zone`}
							className="h-7"
							list={`${id}-zones`}
							value={trigger.timezone}
							aria-invalid={error ? true : undefined}
							onChange={(event) =>
								onChange({ ...trigger, timezone: event.target.value })
							}
						/>
						<datalist id={`${id}-zones`}>
							{timezones().map((zone) => (
								<option key={zone} value={zone} />
							))}
						</datalist>
					</AutomationField>
				)}
			</div>
			{error ? (
				<AutomationNotice tone="error">{error}</AutomationNotice>
			) : (
				<p className="text-[11px] text-muted-foreground" aria-live="polite">
					{next
						? `Next run ${formatAutomationTime(next)}${form.kind === "once" ? " in your local time" : ""}`
						: "This schedule has no upcoming runs."}
				</p>
			)}
		</div>
	);
}
