"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type {
	Category,
	FeatureKey,
	PlatformKey,
	TableRow,
	Tri,
} from "@/lib/cloud-agents";

const CATEGORY_ORDER: Category[] = [
	"Cloud agent",
	"Agent workspace",
	"Terminal agent",
	"IDE agent",
	"App builder",
	"Code review",
	"Task runner",
	"Multi-agent swarm",
];

const FEATURE_LABELS: Record<FeatureKey, { short: string; long: string }> = {
	cloud: { short: "Cloud", long: "Hosted cloud agents" },
	remote: {
		short: "Remote",
		long: "Runs on your own remote machine, over SSH or self-hosted",
	},
	orchestration: { short: "Parallel", long: "Multi-agent or parallel agents" },
	byo: { short: "BYO", long: "Bring your own subscription or API key" },
	mcp: { short: "MCP", long: "Model Context Protocol support" },
	plugins: { short: "Plugins", long: "Plugins or extensions" },
};
const FEATURE_ORDER: FeatureKey[] = [
	"cloud",
	"remote",
	"orchestration",
	"byo",
	"mcp",
	"plugins",
];

const PLATFORM_LABELS: Record<PlatformKey, string> = {
	macos: "macOS",
	windows: "Windows",
	linux: "Linux",
	web: "Web",
	ios: "iOS",
	android: "Android",
};
const PLATFORM_ORDER: PlatformKey[] = [
	"macos",
	"windows",
	"linux",
	"web",
	"ios",
	"android",
];

type SortKey =
	| "default"
	| "name"
	| "category"
	| "agents"
	| "reputation"
	| "since"
	| "license"
	| "free"
	| FeatureKey
	| PlatformKey;

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
	{ value: "default", label: "Category" },
	{ value: "reputation", label: "Reputation" },
	{ value: "name", label: "Name" },
	{ value: "agents", label: "Agents supported" },
	{ value: "since", label: "Newest" },
];

const triRank = (v: Tri) => (v === "yes" ? 2 : v === "unknown" ? 1 : 0);

type FilterKey = "openSource" | FeatureKey | PlatformKey;
const FILTERS: { key: FilterKey; label: string }[] = [
	{ key: "openSource", label: "Open source" },
	...FEATURE_ORDER.map((k) => ({
		key: k,
		label: FEATURE_LABELS[k].long.split(",")[0],
	})),
	...PLATFORM_ORDER.map((k) => ({ key: k, label: PLATFORM_LABELS[k] })),
];

function rowValue(row: TableRow, key: FilterKey): Tri {
	if (key === "openSource") return row.openSource;
	if (key in row.features) return row.features[key as FeatureKey];
	return row.platforms[key as PlatformKey];
}

function TriCell({ value, label }: { value: Tri; label: string }) {
	const text = value === "yes" ? "Yes" : value === "no" ? "No" : "—";
	return (
		<td className="agents-tri" data-value={value}>
			<span title={`${label}: ${value === "unknown" ? "not verified" : text}`}>
				{text}
			</span>
		</td>
	);
}

function compareRows(a: TableRow, b: TableRow, key: SortKey): number {
	switch (key) {
		case "name":
			return a.name.localeCompare(b.name);
		case "category":
			return (
				CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
			);
		case "agents":
			return (
				b.agents.length + Number(b.acp) - (a.agents.length + Number(a.acp))
			);
		case "reputation":
			return (b.reputation ?? -1) - (a.reputation ?? -1);
		case "since":
			return (b.since ?? "").localeCompare(a.since ?? "");
		case "license":
			return triRank(b.openSource) - triRank(a.openSource);
		case "free":
			return triRank(b.freeCloud) - triRank(a.freeCloud);
		case "default":
			return (
				CATEGORY_ORDER.indexOf(a.category) -
					CATEGORY_ORDER.indexOf(b.category) ||
				Number(b.verification === "hand") - Number(a.verification === "hand") ||
				(b.reputation ?? -1) - (a.reputation ?? -1)
			);
		default:
			if (key in a.features)
				return (
					triRank(b.features[key as FeatureKey]) -
					triRank(a.features[key as FeatureKey])
				);
			return (
				triRank(b.platforms[key as PlatformKey]) -
				triRank(a.platforms[key as PlatformKey])
			);
	}
}

const formatSince = (since: string | null) => {
	if (!since) return "—";
	const [y, m] = since.split("-");
	if (!m) return y;
	const month = new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleString(
		"en-US",
		{
			month: "short",
			timeZone: "UTC",
		},
	);
	return `${month} ${y}`;
};

const hostOf = (url: string) => {
	try {
		const u = new URL(url);
		return (
			u.hostname.replace(/^www\./, "") +
			(u.pathname.length > 1 ? u.pathname.replace(/\/$/, "") : "")
		);
	} catch {
		return url;
	}
};

interface SortState {
	key: SortKey;
	reverse: boolean;
}

function SortHeader({
	k,
	sort,
	onSort,
	children,
	title,
	className,
}: {
	k: SortKey;
	sort: SortState;
	onSort: (key: SortKey) => void;
	children: React.ReactNode;
	title?: string;
	className?: string;
}) {
	const active = sort.key === k;
	return (
		<th
			scope="col"
			aria-sort={
				active ? (sort.reverse ? "ascending" : "descending") : undefined
			}
			className={className}
			title={title}
		>
			<button type="button" onClick={() => onSort(k)} className="agents-sort">
				{children}
				<span aria-hidden className="agents-sort-mark">
					{active ? (sort.reverse ? "↑" : "↓") : "↕"}
				</span>
			</button>
		</th>
	);
}

export function AgentsTable({ rows }: { rows: TableRow[] }) {
	const [category, setCategory] = useState<Category | "All">("All");
	const [query, setQuery] = useState("");
	const [filters, setFilters] = useState<Set<FilterKey>>(new Set());
	const [hideStale, setHideStale] = useState(false);
	const [sort, setSort] = useState<SortState>({
		key: "default",
		reverse: false,
	});

	const counts = useMemo(() => {
		const map = new Map<string, number>();
		for (const row of rows)
			map.set(row.category, (map.get(row.category) ?? 0) + 1);
		return map;
	}, [rows]);

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		const out = rows.filter((row) => {
			if (category !== "All" && row.category !== category) return false;
			if (
				hideStale &&
				row.status &&
				/archived|inactive|shut down/i.test(row.status)
			)
				return false;
			for (const key of filters) if (rowValue(row, key) !== "yes") return false;
			if (q) {
				const hay =
					`${row.name} ${row.description ?? ""} ${row.agents.join(" ")} ${row.category}`.toLowerCase();
				if (!hay.includes(q)) return false;
			}
			return true;
		});
		out.sort((a, b) => {
			const d = compareRows(a, b, sort.key) || a.name.localeCompare(b.name);
			return sort.reverse ? -d : d;
		});
		return out;
	}, [rows, category, query, filters, hideStale, sort]);

	const toggleFilter = (key: FilterKey) =>
		setFilters((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});

	const sortBy = (key: SortKey) =>
		setSort((prev) => ({
			key,
			reverse: prev.key === key ? !prev.reverse : false,
		}));

	return (
		<div className="agents-directory">
			<nav aria-label="Categories" className="journal-tabs agents-tabs">
				{(["All", ...CATEGORY_ORDER] as const).map((c) => (
					<button
						key={c}
						type="button"
						className="journal-tab"
						aria-pressed={category === c}
						onClick={() => setCategory(c)}
					>
						{c}
						<span className="journal-tab-count">
							{c === "All" ? rows.length : (counts.get(c) ?? 0)}
						</span>
					</button>
				))}
			</nav>

			<div className="agents-toolbar">
				<label className="agents-search">
					<span className="sr-only">Search products</span>
					<input
						type="search"
						placeholder="Search name, agent or description"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
				</label>
				<label className="agents-select">
					<span>Sort</span>
					<select
						value={
							SORT_OPTIONS.some((o) => o.value === sort.key) ? sort.key : ""
						}
						onChange={(e) =>
							setSort({ key: e.target.value as SortKey, reverse: false })
						}
					>
						{!SORT_OPTIONS.some((o) => o.value === sort.key) && (
							<option value="">Column</option>
						)}
						{SORT_OPTIONS.map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</select>
				</label>
				<label className="agents-check">
					<input
						type="checkbox"
						checked={hideStale}
						onChange={(e) => setHideStale(e.target.checked)}
					/>
					Hide archived, inactive and shut down
				</label>
			</div>
			<fieldset className="agents-filters">
				<legend className="agents-filters-label">Only show:</legend>
				{FILTERS.map((f) => (
					<button
						key={f.key}
						type="button"
						className="agents-chip"
						aria-pressed={filters.has(f.key)}
						onClick={() => toggleFilter(f.key)}
					>
						{f.label}
					</button>
				))}
				{filters.size > 0 && (
					<button
						type="button"
						className="agents-chip agents-chip-clear"
						onClick={() => setFilters(new Set())}
					>
						Clear
					</button>
				)}
			</fieldset>
			<p className="agents-count" aria-live="polite">
				Showing {visible.length} of {rows.length}
			</p>

			<section
				className="agents-scroll"
				aria-label="Comparison table, scrolls sideways"
			>
				<table className="agents-table">
					<thead>
						<tr>
							<SortHeader
								sort={sort}
								onSort={sortBy}
								k="name"
								className="agents-sticky"
							>
								Product
							</SortHeader>
							<SortHeader sort={sort} onSort={sortBy} k="category">
								Category
							</SortHeader>
							<SortHeader
								sort={sort}
								onSort={sortBy}
								k="agents"
								title="Agents or harnesses the product names in its docs"
							>
								Agents
							</SortHeader>
							{FEATURE_ORDER.map((k) => (
								<SortHeader
									sort={sort}
									onSort={sortBy}
									key={k}
									k={k}
									title={FEATURE_LABELS[k].long}
								>
									{FEATURE_LABELS[k].short}
								</SortHeader>
							))}
							<SortHeader
								sort={sort}
								onSort={sortBy}
								k="license"
								title="Open source license"
							>
								Open source
							</SortHeader>
							{PLATFORM_ORDER.map((k) => (
								<SortHeader sort={sort} onSort={sortBy} key={k} k={k}>
									{PLATFORM_LABELS[k]}
								</SortHeader>
							))}
							<th scope="col">Price</th>
							<SortHeader
								sort={sort}
								onSort={sortBy}
								k="free"
								title="Can you run hosted cloud agents for $0?"
							>
								Free cloud
							</SortHeader>
							<SortHeader
								sort={sort}
								onSort={sortBy}
								k="reputation"
								title="0–100, see method below"
							>
								Reputation
							</SortHeader>
							<SortHeader sort={sort} onSort={sortBy} k="since">
								Since
							</SortHeader>
							<th scope="col" className="agents-notes-col">
								Notes
							</th>
						</tr>
					</thead>
					<tbody>
						{visible.map((row) => (
							<tr key={row.id} id={row.id}>
								<th scope="row" className="agents-sticky">
									<a
										href={row.url}
										rel="nofollow noopener"
										target="_blank"
										className="agents-name"
									>
										{row.name}
									</a>
									{row.status && (
										<span className="agents-status">{row.status}</span>
									)}
									{row.verification === "hand" && (
										<span
											className="agents-hand"
											title="Every cell checked by hand"
										>
											Hand-checked
										</span>
									)}
								</th>
								<td className="agents-muted">{row.category}</td>
								<td className="agents-agents">
									{row.agents.length === 0 && !row.acp ? (
										"—"
									) : (
										<details>
											<summary>
												<span className="agents-num">{row.agents.length}</span>
												{row.acp && <span className="agents-plus">+ACP</span>}
											</summary>
											<span className="agents-list">
												{row.agents.join(", ")}
												{row.acp &&
													(row.agents.length
														? ", any ACP agent"
														: "Any ACP agent")}
												{row.agentsNote && (
													<span className="agents-muted">
														{" "}
														{row.agentsNote}
													</span>
												)}
											</span>
										</details>
									)}
								</td>
								{FEATURE_ORDER.map((k) => (
									<TriCell
										key={k}
										value={row.features[k]}
										label={FEATURE_LABELS[k].long}
									/>
								))}
								<td className="agents-tri" data-value={row.openSource}>
									{row.openSource === "yes"
										? row.license
										: row.openSource === "no"
											? "No"
											: "—"}
								</td>
								{PLATFORM_ORDER.map((k) => (
									<TriCell
										key={k}
										value={row.platforms[k]}
										label={PLATFORM_LABELS[k]}
									/>
								))}
								<td className="agents-price">{row.pricing ?? "—"}</td>
								<TriCell value={row.freeCloud} label="Free cloud tier" />
								<td className="agents-num-cell">{row.reputation ?? "—"}</td>
								<td className="agents-muted agents-nowrap">
									{formatSince(row.since)}
								</td>
								<td className="agents-notes">
									<details>
										<summary>{row.description ?? "Details"}</summary>
										<div className="agents-more">
											{row.pricingDetail && <p>{row.pricingDetail}</p>}
											{row.notes && <p>{row.notes}</p>}
											{row.integrations.length > 0 && (
												<p>
													Integrations named: {row.integrations.join(", ")}.
												</p>
											)}
											<p className="agents-muted">
												{row.stars !== null && (
													<>
														GitHub stars {row.stars.toLocaleString("en-US")}.{" "}
													</>
												)}
												{row.hnStories !== null && (
													<>Hacker News stories {row.hnStories}. </>
												)}
												{row.pushedAt && <>Last push {row.pushedAt}. </>}
												{row.sinceNote && (
													<>Since: {row.sinceNote.toLowerCase()}. </>
												)}
											</p>
											{row.compare && (
												<p>
													<Link
														href={row.compare.href}
														className="text-primary underline underline-offset-4"
													>
														{row.compare.label}
													</Link>
												</p>
											)}
											<p className="agents-sources">
												Sources:{" "}
												{row.sources.map((src, i) => (
													<span key={src}>
														{i > 0 && ", "}
														<a
															href={src}
															rel="nofollow noopener"
															target="_blank"
														>
															{hostOf(src)}
														</a>
													</span>
												))}
											</p>
										</div>
									</details>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>
		</div>
	);
}
