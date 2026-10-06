export const property = (key, value) => ({
	key,
	value: [value],
	operator: "exact",
	type: "event",
});
const series = (event, surface, math = "total", extra = {}) => ({
	kind: "EventsNode",
	event,
	name: event,
	math,
	properties: [
		property("analytics_schema_version", 2),
		property("surface", surface),
	],
	...extra,
});
const trend = (event, surface, math = "total", breakdown, extra = {}) => ({
	kind: "TrendsQuery",
	dateRange: { date_from: "-30d" },
	interval: "day",
	series: [series(event, surface, math, extra)],
	trendsFilter: { display: breakdown ? "ActionsBar" : "ActionsLineGraph" },
	...(breakdown
		? { breakdownFilter: { breakdown, breakdown_type: "event" } }
		: {}),
});
const funnel = (steps) => ({
	kind: "FunnelsQuery",
	dateRange: { date_from: "-30d" },
	series: steps.map(([event, surface, properties = []]) =>
		series(event, surface, "total", {
			properties: [...series(event, surface).properties, ...properties],
		}),
	),
	funnelsFilter: {
		funnelVizType: "steps",
		funnelOrderType: "ordered",
		funnelWindowInterval: 1,
		funnelWindowIntervalUnit: "day",
	},
});
const tile = (name, description, query) => ({
	name,
	description,
	query: { kind: "InsightVizNode", source: query },
});
export const analyticsDashboards = [
	{
		name: "Zuse - Website acquisition",
		description:
			"Visitors, download intent, docs referrals, and devices. Download clicks do not prove completed downloads or installations. Anonymous browser identities persist for 90 days and are shared with docs; app identities remain separate.",
		tiles: [
			tile(
				"Website - Daily visitors",
				"Unique anonymous browser identities per day; privacy signals and blockers exclude traffic.",
				trend("$pageview", "website", "dau"),
			),
			tile(
				"Website - Pageviews",
				"Total tracked marketing pageviews.",
				trend("$pageview", "website"),
			),
			tile(
				"Website - Download clicks",
				"Total download link clicks, including direct release installers. This is download intent, not completed transfers.",
				trend("website_download_clicked", "website"),
			),
			tile(
				"Website - Installer redirects",
				"Successful installer redirects for visitors with a tracking cookie. Excludes direct requests without a cookie; cannot verify completed transfers.",
				{
					...trend("website_download_resolved", "website"),
					series: [
						series("website_download_resolved", "website", "total", {
							properties: [
								...series("website_download_resolved", "website").properties,
								property("download_outcome", "installer"),
							],
						}),
					],
				},
			),
			tile(
				"Website - Download resolution outcomes",
				"Installer redirects versus releases-page fallbacks for tracked requests. Failures can indicate unavailable release assets or unsupported platforms.",
				trend(
					"website_download_resolved",
					"website",
					"total",
					"download_outcome",
				),
			),

			tile(
				"Website - People clicking download",
				"Unique browser identities clicking a download link each day.",
				trend("website_download_clicked", "website", "dau"),
			),
			tile(
				"Website - Visitor to download funnel",
				"Ordered visitor, download click, and successful installer redirect within one day. Excludes untracked requests and does not prove installation.",
				funnel([
					["$pageview", "website"],
					["website_download_clicked", "website"],
					[
						"website_download_resolved",
						"website",
						[property("download_outcome", "installer")],
					],
				]),
			),
			tile(
				"Website - Visitor to docs engagement funnel",
				"Ordered pageview, docs link click, docs pageview, and engaged reading within one day. Requires both sites to use the same project key and shared first-party cookie.",
				funnel([
					["$pageview", "website"],
					["website_docs_clicked", "website"],
					["$pageview", "docs"],
					["docs_page_engaged", "docs"],
				]),
			),
			tile(
				"Website - Devices",
				"Unique visitors by browser-reported device category.",
				trend("$pageview", "website", "dau", "$device_type"),
			),
			tile(
				"Website - Operating systems",
				"Unique visitors by browser-reported operating system.",
				trend("$pageview", "website", "dau", "$os"),
			),
			tile(
				"Website - Referring domains",
				"Unique visitors by referring domain; URL queries and referring paths are removed.",
				trend("$pageview", "website", "dau", "$referring_domain"),
			),
			tile(
				"Website - Download targets",
				"Clicks by selected installer target; auto means the redirect chooses the platform.",
				trend(
					"website_download_clicked",
					"website",
					"total",
					"download_target",
				),
			),
			tile(
				"Website - Download placements",
				"Download link clicks from navigation, content, or footer.",
				trend("website_download_clicked", "website", "total", "placement"),
			),
		],
	},
	{
		name: "Zuse - Docs engagement",
		description:
			"Docs reach and useful-reading proxies. Engaged means at least 30 active foreground seconds plus 50% scroll on a page. It measures reading behavior, not sentiment. Search terms and copied content are never collected.",
		tiles: [
			tile(
				"Docs - Daily readers",
				"Unique anonymous browser identities visiting documentation per day.",
				trend("$pageview", "docs", "dau"),
			),
			tile(
				"Docs - Pageviews",
				"Total documentation pageviews.",
				trend("$pageview", "docs"),
			),
			tile(
				"Docs - Engaged readers",
				"Unique readers with 30 active seconds and 50% scroll on a page.",
				trend("docs_page_engaged", "docs", "dau"),
			),
			tile(
				"Docs - Popular pages",
				"Documentation pageviews by sanitized public path.",
				trend("$pageview", "docs", "total", "$pathname"),
			),
			tile(
				"Docs - Engaged pages",
				"One engagement event per page visit, grouped by public page path.",
				trend("docs_page_engaged", "docs", "total", "page_path"),
			),
			tile(
				"Docs - Reading drop-off",
				"Visitors who reach engaged reading within one day. Opening a page alone does not count as engagement.",
				funnel([
					["$pageview", "docs"],
					["docs_page_engaged", "docs"],
				]),
			),
			tile(
				"Docs - Website referrals",
				"Unique website visitors clicking a docs link. Use the acquisition funnel to see who actually arrives.",
				trend("website_docs_clicked", "website", "dau"),
			),
			tile(
				"Docs - Devices",
				"Unique docs readers by browser device category.",
				trend("$pageview", "docs", "dau", "$device_type"),
			),
			tile(
				"Docs - Return reading",
				"Weekly return visits by anonymous browser identity.",
				{
					kind: "RetentionQuery",
					dateRange: { date_from: "-90d" },
					retentionFilter: {
						targetEntity: {
							id: "$pageview",
							type: "events",
							properties: series("$pageview", "docs").properties,
						},
						returningEntity: {
							id: "$pageview",
							type: "events",
							properties: series("$pageview", "docs").properties,
						},
						retentionType: "retention_first_time",
						period: "Week",
						totalIntervals: 8,
					},
				},
			),
		],
	},
	{
		name: "Zuse - Desktop usage",
		description:
			"Active app identities, chat creators, total chats, activation drop-offs, devices, and reliability. Signed-out installs and account hashes are identities, not exact people. Website-to-install attribution is not linked.",
		tiles: [
			tile(
				"Desktop - Daily active users",
				"Unique identities emitting active foreground intervals per day.",
				trend("app active interval", "desktop", "dau"),
			),
			tile(
				"Desktop - Weekly active users",
				"Unique active identities per week; not a sum of daily users.",
				{ ...trend("app active interval", "desktop", "dau"), interval: "week" },
			),
			tile(
				"Desktop - Monthly active users",
				"Unique active identities per month.",
				{
					...trend("app active interval", "desktop", "dau"),
					interval: "month",
				},
			),
			tile(
				"Desktop - Chat creators",
				"Unique identities creating chats per day.",
				trend("chat created", "desktop", "dau"),
			),
			tile(
				"Desktop - Chats created",
				"Total durable chat creation events. Provider readiness is measured separately.",
				trend("chat created", "desktop"),
			),
			tile(
				"Desktop - Messages submitted",
				"Total submitted messages, excluding prompt contents.",
				trend("message submitted", "desktop"),
			),
			tile(
				"Desktop - Activation drop-off",
				"Ordered app open, chat creation, message submission, and completed turn within one day; users can also use existing chats.",
				funnel([
					["app opened", "desktop"],
					["chat created", "desktop"],
					["message submitted", "desktop"],
					["turn completed", "desktop"],
				]),
			),
			tile(
				"Desktop - Onboarding drop-off",
				"Ordered onboarding view, completion of a step, and full onboarding completion within one day.",
				funnel([
					["onboarding step viewed", "desktop"],
					["onboarding step completed", "desktop"],
					["onboarding completed", "desktop"],
				]),
			),
			tile(
				"Desktop - Operating systems",
				"Active identities by operating system.",
				trend("app active interval", "desktop", "dau", "os"),
			),
			tile(
				"Desktop - Architectures",
				"Active identities by CPU architecture.",
				trend("app active interval", "desktop", "dau", "architecture"),
			),
			tile(
				"Desktop - Releases",
				"Active identities by app version.",
				trend("app active interval", "desktop", "dau", "app_version"),
			),
			tile(
				"Desktop - Turn outcomes",
				"Total completed, failed, and interrupted turns.",
				{
					...trend("turn completed", "desktop"),
					series: ["turn completed", "turn failed", "turn interrupted"].map(
						(event) => series(event, "desktop"),
					),
				},
			),
			tile(
				"Desktop - Active minutes",
				"Sum of measured foreground active seconds, converted to minutes.",
				{
					...trend("app active interval", "desktop", "sum", undefined, {
						math_property: "active_seconds",
					}),
					trendsFilter: {
						display: "ActionsLineGraph",
						formulaNodes: [{ formula: "A / 60" }],
					},
				},
			),
		],
	},
];

// These period totals count each identity once across the entire window, rather
// than adding daily unique counts. One event scan produces each summary table.
const totals = [
	[
		"website",
		"Website - 30-day totals",
		"Observed browser identities, download intent, successful installer redirects, and docs referrals over the full last 30 days.",
		"uniqExactIf(distinct_id, event = '$pageview') AS visitors, uniqExactIf(distinct_id, event = 'website_download_clicked') AS download_clickers, countIf(event = 'website_download_clicked') AS download_clicks, countIf(event = 'website_download_resolved' AND properties.download_outcome = 'installer') AS installer_redirects, uniqExactIf(distinct_id, event = 'website_docs_clicked') AS docs_referrers",
	],
	[
		"docs",
		"Docs - 30-day totals",
		"Observed browser identities, pageviews, and engaged readers over the full last 30 days.",
		"uniqExactIf(distinct_id, event = '$pageview') AS readers, countIf(event = '$pageview') AS pageviews, uniqExactIf(distinct_id, event = 'docs_page_engaged') AS engaged_readers",
	],
	[
		"desktop",
		"Desktop - 30-day totals",
		"Observed active identities, chat creators, total chats, and submitted messages over the full last 30 days. Identities are not exact people.",
		"uniqExactIf(distinct_id, event = 'app active interval') AS active_identities, uniqExactIf(distinct_id, event = 'chat created') AS chat_creators, countIf(event = 'chat created') AS chats_created, countIf(event = 'message submitted') AS messages_submitted",
	],
];
for (const [surface, name, description, projection] of totals) {
	const dashboard = analyticsDashboards.find(
		(item) =>
			item.name ===
			`Zuse - ${surface === "website" ? "Website acquisition" : surface === "docs" ? "Docs engagement" : "Desktop usage"}`,
	);
	dashboard.tiles.unshift({
		name,
		description,
		query: {
			kind: "DataVisualizationNode",
			display: "ActionsTable",
			source: {
				kind: "HogQLQuery",
				query: `SELECT ${projection} FROM events WHERE timestamp >= now() - INTERVAL 30 DAY AND properties.analytics_schema_version = 2 AND properties.surface = '${surface}'`,
			},
		},
	});
}

export function layoutAnalyticsDashboard(definition, tiles) {
	let y = 0;
	let x = 0;
	return definition.tiles.flatMap((insight) => {
		const tile = tiles.find(
			(tile) => !tile.deleted && tile.insight?.name === insight.name,
		);
		if (!tile) return [];
		const fullWidth =
			insight.query.kind === "DataVisualizationNode" ||
			insight.query.source?.kind === "FunnelsQuery";
		if (fullWidth && x) {
			y += 5;
			x = 0;
		}
		const w = fullWidth ? 12 : 6;
		const h =
			insight.query.kind === "DataVisualizationNode" ? 3 : fullWidth ? 6 : 5;
		const result = { id: tile.id, layouts: { sm: { x, y, w, h } } };
		if (fullWidth || x === 6) {
			y += h;
			x = 0;
		} else x = 6;
		return [result];
	});
}
