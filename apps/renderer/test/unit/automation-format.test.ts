import {
	type Automation,
	type AutomationConfig,
	FolderId,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	AGENT_SOURCE_KEY,
	AGENT_SOURCE_VALUE,
	describeTrigger,
	filterAutomations,
	fromDateTimeLocal,
	presetCron,
	scheduleForm,
	toDateTimeLocal,
} from "../../src/lib/automation-format.ts";

const schedule = (cron: string, onceAt?: string) => ({
	_tag: "schedule" as const,
	cron,
	timezone: "UTC",
	...(onceAt ? { onceAt } : {}),
});

describe("automation schedules", () => {
	it("recognises editable presets and round-trips them to cron", () => {
		for (const cron of ["15 * * * *", "30 8 * * *", "0 9 * * 1"])
			expect(presetCron(scheduleForm(schedule(cron)))).toBe(cron);
		expect(scheduleForm(schedule("0 9 * * MON"))).toMatchObject({
			kind: "weekly",
			weekday: 1,
		});
		expect(scheduleForm(schedule("0 9 * * 7")).weekday).toBe(0);
	});
	it("keeps anything else as a custom schedule", () => {
		for (const cron of ["30 9 * * 1-5", "0 9 1 * *", "*/5 * * * *", "bad"])
			expect(scheduleForm(schedule(cron)).kind).toBe("custom");
		expect(
			scheduleForm(schedule("0 9 * * *", "2026-10-05T09:00:00Z")).kind,
		).toBe("once");
	});
	it("converts run-once times between the local picker and absolute timestamps", () => {
		const iso = fromDateTimeLocal("2026-10-05T09:30");
		expect(iso).toMatch(/Z$/u);
		expect(toDateTimeLocal(iso ?? "")).toBe("2026-10-05T09:30");
		expect(fromDateTimeLocal("")).toBeNull();
	});
	it("summarises triggers in plain language", () => {
		expect(describeTrigger(schedule("0 9 * * 1"))).toContain(
			"Every Monday at 09:00",
		);
		expect(
			describeTrigger({
				_tag: "github",
				events: ["pull_request", "check_run"],
				repositories: ["acme/web"],
				actions: [],
			}),
		).toBe("GitHub pull request, check run in acme/web");
		expect(describeTrigger({ _tag: "manual" })).toBe("Manual runs only");
	});
});

const automation = (
	id: string,
	config: Partial<AutomationConfig>,
): Automation => ({
	id,
	revision: 1,
	createdAt: "2026-10-04T00:00:00Z",
	updatedAt: "2026-10-04T00:00:00Z",
	nextRunAt: null,
	config: {
		projectId: FolderId.make("repo"),
		name: id,
		description: "",
		enabled: true,
		triggers: [{ _tag: "manual" }],
		action: "new_session",
		sessionId: null,
		prompt: "Do work",
		providerId: "claude",
		model: "m",
		modelOptions: {},
		runtimeMode: "approval-required",
		runAs: "owner",
		worktreeId: null,
		environment: "local",
		mcpServerIds: [],
		allowChildSessions: false,
		network: { enabled: true, allowedDomains: [] },
		metadata: {},
		spendLimitUsd: null,
		rateLimit: { count: 5, windowSeconds: 3600 },
		queue: { enabled: true, maxConcurrency: 1 },
		notifications: [],
		...config,
	},
});

describe("automation library filters", () => {
	const records = [
		automation("nightly", { triggers: [schedule("0 2 * * *")] }),
		automation("draft", {
			enabled: false,
			metadata: { [AGENT_SOURCE_KEY]: AGENT_SOURCE_VALUE },
		}),
		automation("paused", {
			enabled: false,
			projectId: FolderId.make("other"),
		}),
	];
	const ids = (result: ReadonlyArray<Automation>) => result.map((r) => r.id);
	it("separates agent drafts from ordinary paused automations", () => {
		expect(ids(filterAutomations(records, "", "drafts", null))).toEqual([
			"draft",
		]);
		expect(ids(filterAutomations(records, "", "paused", null))).toEqual([
			"draft",
			"paused",
		]);
	});
	it("searches trigger summaries and scopes to a project", () => {
		expect(ids(filterAutomations(records, "every day", "all", null))).toEqual([
			"nightly",
		]);
		expect(ids(filterAutomations(records, "", "all", "other"))).toEqual([
			"paused",
		]);
	});
});
