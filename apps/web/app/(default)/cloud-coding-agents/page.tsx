import Link from "next/link";
import { AgentsTable } from "@/components/cloud-agents/agents-table";
import { AgentsStructuredData } from "@/components/seo/agents-structured-data";
import {
	AGENT_ROWS,
	CATEGORIES,
	CHECKED_ON_LABEL,
	CORRECTIONS_EMAIL,
	DIRECTORY_META,
	REPUTATION_MAX,
	toTableRow,
} from "@/lib/cloud-agents";
import { getSEO } from "@/lib/seo";

const PATH = "/cloud-coding-agents";
const TITLE = "Cloud coding agents, compared";
const DESCRIPTION = `${AGENT_ROWS.length} cloud coding agents, agent workspaces and coding CLIs compared on hosted cloud, remote and self-hosted runs, parallel agents, bring-your-own plans, MCP, plugins, platforms, license, price and reputation. Checked ${CHECKED_ON_LABEL}.`;

export const metadata = getSEO({
	absoluteTitle: `${TITLE} (${AGENT_ROWS.length} tools) | Zuse`,
	description: DESCRIPTION,
	path: PATH,
	keywords: [
		"cloud coding agents",
		"background coding agents",
		"coding agent comparison",
		"Codex cloud",
		"Claude Code on the web",
		"Cursor cloud agents",
		"Devin",
		"open source coding agents",
	],
});

export default function CloudCodingAgentsPage() {
	const rows = AGENT_ROWS.map(toTableRow);
	const handChecked = AGENT_ROWS.filter(
		(r) => r.verification === "hand",
	).length;
	return (
		<main className="journal-index agents-page">
			<AgentsStructuredData
				rows={AGENT_ROWS}
				path={PATH}
				title={TITLE}
				description={DESCRIPTION}
			/>
			<header className="journal-masthead">
				<p className="editorial-label">Directory · {AGENT_ROWS.length} tools</p>
				<h1 className="mt-5 text-[clamp(2.75rem,6vw,5rem)] leading-none">
					Cloud coding agents,{" "}
					<span className="heading-accent text-primary">compared.</span>
				</h1>
				<p className="mt-6 max-w-2xl text-base leading-7 text-muted-foreground">
					Every product that runs coding agents for you, in the cloud, on your
					own machines, or side by side on your laptop. We read each value from
					the company&apos;s own pricing page, docs, changelog or repository,
					and we link the source for every row. Where a source did not say, the
					cell shows “—”, not a guess.
				</p>
				<p className="agents-stamp">
					We checked them on {CHECKED_ON_LABEL}. Wrong row?{" "}
					<a
						href={`mailto:${CORRECTIONS_EMAIL}?subject=Cloud%20coding%20agents%20correction`}
					>
						{CORRECTIONS_EMAIL}
					</a>{" "}
					or{" "}
					<a
						href="https://github.com/swarajbachu/zuse/issues/new?title=Cloud%20coding%20agents%20correction"
						rel="noopener"
					>
						open an issue
					</a>
					.
				</p>
			</header>

			<section
				className="journal-section agents-section"
				aria-label="Comparison table"
			>
				<AgentsTable rows={rows} />
			</section>

			<section className="journal-section agents-method" id="method">
				<h2 className="journal-section-label font-mono">How we built this</h2>
				<div className="agents-method-grid">
					<div>
						<h3>Two levels of checking</h3>
						<p>
							The {handChecked} rows marked <em>Hand-checked</em> were read line
							by line from each company&apos;s pricing page, docs and changelog
							on {CHECKED_ON_LABEL}. Prices are the cheapest plan that includes
							the hosted cloud agent, in USD per month as listed.
						</p>
						<p>
							The other {AGENT_ROWS.length - handChecked} rows were found
							through GitHub topics, the Agent Client Protocol registry,
							community lists and vendor sites. For these, license, stars,
							creation date and last push come from the GitHub API. Platforms
							come from the latest release&apos;s assets (.dmg, .exe, .AppImage
							and so on) or the README. Features are marked “Yes” only when the
							README or homepage says so; the matching sentence and URL are
							stored with the data. Nothing on these rows is marked “No”:
							absence of a claim is shown as “—”.
						</p>
						<p>
							Zuse publishes this page and has a row in it. Our row comes from
							the Zuse source code and docs, and it gets the same “—” where we
							can&apos;t point to a source.
						</p>
					</div>
					<div>
						<h3>Reputation score</h3>
						<p>
							A 0–100 popularity signal from public counts, nothing editorial:
						</p>
						<ul>
							<li>
								<strong>GitHub stars</strong> of the main repository, from the
								GitHub API.
							</li>
							<li>
								<strong>Hacker News stories</strong> whose link points at the
								product&apos;s site or repository, from the{" "}
								<a href="https://hn.algolia.com/api" rel="noopener">
									HN Algolia API
								</a>
								.
							</li>
						</ul>
						<p className="agents-formula">
							signal = log10(1 + count) ÷ log10(1 + largest count on the page)
							<br />
							score = round(100 × average of the signals a row has)
						</p>
						<p>
							Today the largest counts are{" "}
							{REPUTATION_MAX.stars.toLocaleString("en-US")} stars and{" "}
							{REPUTATION_MAX.hnStories} HN stories. Rows with neither signal
							show “—”. Products that live on a shared domain, like GitHub
							Copilot, have no fair HN count and no stars, so they show “—”
							rather than a misleading low score. Domain counts cover every
							story ever linked from that domain, which can include a company&apos;s
							other or older products. Raw inputs and the fetch date are in the
							data file.
						</p>
					</div>
					<div>
						<h3>Columns</h3>
						<dl className="agents-defs">
							<dt>Agents</dt>
							<dd>
								Agents or harnesses the product names in its docs. +ACP means
								any Agent Client Protocol agent. Shown for workspaces, runners
								and cloud products.
							</dd>
							<dt>Cloud</dt>
							<dd>Runs agents on hosted machines you don&apos;t manage.</dd>
							<dt>Remote</dt>
							<dd>Runs on your own server, over SSH, or self-hosted.</dd>
							<dt>Parallel</dt>
							<dd>Runs several agents at once or orchestrates sub-agents.</dd>
							<dt>BYO</dt>
							<dd>Accepts your own model subscription or API key.</dd>
							<dt>Free cloud</dt>
							<dd>
								A $0 way to run the hosted cloud agent. A free local app does
								not count.
							</dd>
							<dt>Status</dt>
							<dd>
								Shutting down, acquired, archived on GitHub, or inactive (no
								push since 1 August 2026).
							</dd>
						</dl>
					</div>
				</div>
				<p className="agents-footnote">
					Left out: {DIRECTORY_META.excluded.length} candidates we could not
					verify or that no longer build coding agents (
					{DIRECTORY_META.excluded.map((e) => e.id).join(", ")}). Categories:{" "}
					{CATEGORIES.join(", ")}. Layout inspired by{" "}
					<a href="https://orble.tech/sandboxes" rel="noopener">
						Orble&apos;s sandbox comparison
					</a>
					. Want the longer take?{" "}
					<Link href="/blog/best-cloud-coding-agents">
						The best cloud coding agents
					</Link>{" "}
					and{" "}
					<Link href="/blog/open-source-cloud-agents">
						a guide to open source cloud agents
					</Link>
					.
				</p>
			</section>
		</main>
	);
}
