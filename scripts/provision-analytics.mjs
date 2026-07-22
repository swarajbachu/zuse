#!/usr/bin/env node

/**
 * Idempotently provisions product analytics. This script requires an
 * operations-only personal API key; only public ingest keys ship in apps.
 */
const dryRun = process.argv.includes("--dry-run");
const apiKey =
	process.env.POSTHOG_PERSONAL_API_KEY?.trim() || (dryRun ? "dry-run" : "");
const projectId =
	process.env.POSTHOG_PROJECT_ID?.trim() || (dryRun ? "dry-run" : "");
const host = (
	process.env.POSTHOG_CONTROL_HOST ?? "https://us.posthog.com"
).replace(/\/$/, "");

if (!apiKey || !projectId) {
	console.error("Set POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID.");
	process.exit(1);
}

const base = `${host}/api/projects/${projectId}`;
const request = async (path, init = {}) => {
	if (dryRun) {
		if (!init.method || init.method === "GET")
			return { results: [], next: null };
		console.log(`[dry-run] ${init.method} ${path}`);
		return { id: `dry-${path}` };
	}
	const response = await fetch(`${base}${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${apiKey}`,
			"content-type": "application/json",
			...init.headers,
		},
	});
	if (!response.ok)
		throw new Error(`${init.method ?? "GET"} ${path}: ${response.status}`);
	return response.status === 204 ? null : response.json();
};

const listAll = async (path) => {
	const items = [];
	let next = path;
	while (next) {
		const page = await request(next.replace(base, ""));
		items.push(...(page.results ?? []));
		next = page.next;
	}
	return items;
};

const upsertNamed = async (resource, name, body) => {
	const existing = (await listAll(`/${resource}/?limit=200`)).find(
		(item) => item.name === name,
	);
	return existing
		? request(`/${resource}/${existing.id}/`, {
				method: "PATCH",
				body: JSON.stringify(body),
			})
		: request(`/${resource}/`, {
				method: "POST",
				body: JSON.stringify({ name, ...body }),
			});
};

const event = (id) => ({ id, name: id, type: "events", order: 0 });
const trend = (events, extra = {}) => ({
	insight: "TRENDS",
	display: "ActionsLineGraph",
	events: events.map(event),
	...extra,
});
const retention = (start, returning, period, intervals) => ({
	insight: "RETENTION",
	target_entity: event(start),
	returning_entity: event(returning),
	retention_type: "retention_first_time",
	period,
	total_intervals: intervals,
});
const funnel = (events) => ({
	insight: "FUNNELS",
	events: events.map(event),
	funnel_window_interval: 14,
	funnel_window_interval_unit: "day",
});

const dashboards = {
	Executive: [
		["Daily active users", trend(["app active interval"], { interval: "day" })],
		[
			"Weekly active users",
			trend(["app active interval"], { interval: "week" }),
		],
		[
			"Monthly active users",
			trend(["app active interval"], { interval: "month" }),
		],
		[
			"Active seconds",
			trend(["app active interval"], {
				math: "sum",
				math_property: "active_seconds",
			}),
		],
		[
			"Turns and outcomes",
			trend(["turn started", "turn completed", "turn failed"]),
		],
		[
			"Platform distribution",
			trend(["app active interval"], { breakdown: "surface" }),
		],
	],
	Retention: [
		[
			"Daily active retention D0-D14",
			retention("app active interval", "app active interval", "Day", 14),
		],
		[
			"Weekly active retention W0-W12",
			retention("app active interval", "app active interval", "Week", 12),
		],
		[
			"Daily successful-turn retention D0-D14",
			retention("turn completed", "turn completed", "Day", 14),
		],
		[
			"Weekly successful-turn retention W0-W12",
			retention("turn completed", "turn completed", "Week", 12),
		],
	],
	Activation: [
		[
			"First value funnel",
			funnel([
				"app opened",
				"project added",
				"chat created",
				"message submitted",
				"turn completed",
			]),
		],
		[
			"Onboarding drop-off",
			funnel([
				"onboarding step viewed",
				"onboarding step completed",
				"onboarding completed",
			]),
		],
	],
	Models: [
		["Turns by provider", trend(["turn completed"], { breakdown: "provider" })],
		["Turns by safe model", trend(["turn completed"], { breakdown: "model" })],
		[
			"Tokens by model",
			trend(["turn completed"], {
				breakdown: "model",
				math: "sum",
				math_property: "output_tokens",
			}),
		],
		["Model failures", trend(["turn failed"], { breakdown: "model" })],
		["Model switches", trend(["model changed"], { breakdown: "model" })],
	],
	"Time of use": [
		[
			"Active users by local hour",
			trend(["app active interval"], { breakdown: "local_hour" }),
		],
		[
			"Active seconds by weekday",
			trend(["app active interval"], {
				breakdown: "local_weekday",
				math: "sum",
				math_property: "active_seconds",
			}),
		],
		["Timezones", trend(["app active interval"], { breakdown: "timezone" })],
	],
	"Feature and controls": [
		["Screen adoption", trend(["screen viewed"], { breakdown: "screen" })],
		["Top controls", trend(["control activated"], { breakdown: "control" })],
		[
			"Interaction sources",
			trend(["control activated"], { breakdown: "interaction_source" }),
		],
		[
			"Settings use",
			trend(["control activated"], {
				properties: [
					{
						key: "screen",
						value: ["settings"],
						operator: "exact",
						type: "event",
					},
				],
			}),
		],
	],
	"Mobile and connectivity": [
		[
			"Mobile active users",
			trend(["app active interval"], {
				properties: [
					{
						key: "surface",
						value: ["ios", "android"],
						operator: "exact",
						type: "event",
					},
				],
			}),
		],
		["Pairing funnel", funnel(["pairing attempted", "pairing completed"])],
		[
			"Remote connection funnel",
			funnel(["connection attempted", "connection established"]),
		],
		[
			"Reconnect failures",
			trend(["connection failed"], { breakdown: "connection_kind" }),
		],
		[
			"Notification engagement",
			trend(["notification permission decided", "notification opened"]),
		],
	],
	Reliability: [
		["Sanitized errors", trend(["app error"], { breakdown: "error_code" })],
		[
			"Slow operations",
			trend(["operation completed"], { breakdown: "duration_bucket" }),
		],
		[
			"Provider startup failures",
			trend(["provider startup failed"], { breakdown: "provider" }),
		],
		[
			"Interrupted turns",
			trend(["turn interrupted"], { breakdown: "provider" }),
		],
		["Tool outcomes", trend(["tool used"], { breakdown: "tool_category" })],
		[
			"Release regressions",
			trend(["turn failed", "app error"], { breakdown: "app_version" }),
		],
	],
};

for (const [name, body] of [
	["Successful turn", { steps: [{ event: "turn completed" }] }],
	["Active use", { steps: [{ event: "app active interval" }] }],
	[
		"Mobile use",
		{
			steps: [
				{
					event: "app active interval",
					properties: [
						{
							key: "surface",
							value: ["ios", "android"],
							operator: "exact",
						},
					],
				},
			],
		},
	],
]) {
	await upsertNamed("actions", name, body);
}

await upsertNamed("cohorts", "Desktop active", {
	groups: [
		{
			properties: {
				type: "AND",
				values: [
					{
						key: "surface",
						type: "event",
						value: "desktop",
						operator: "exact",
					},
				],
			},
		},
	],
});
await upsertNamed("cohorts", "Mobile active", {
	groups: [
		{
			properties: {
				type: "AND",
				values: [
					{
						key: "surface",
						type: "event",
						value: ["ios", "android"],
						operator: "exact",
					},
				],
			},
		},
	],
});

for (const [dashboardName, insights] of Object.entries(dashboards)) {
	const dashboard = await upsertNamed("dashboards", dashboardName, {
		description: "Managed by scripts/provision-analytics.mjs",
	});
	for (const [name, filters] of insights) {
		await upsertNamed("insights", name, {
			dashboards: [dashboard.id],
			filters,
		});
	}
}

console.log(
	`Provisioned ${Object.keys(dashboards).length} dashboards${dryRun ? " (dry run)" : ""}.`,
);
