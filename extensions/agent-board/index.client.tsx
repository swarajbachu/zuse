import type {
	ExtensionAgentSession,
	ExtensionClientContext,
	ExtensionClientHost,
} from "@zuse/extension-sdk";
import { useState } from "react";
import { columns, filterSessions } from "./board.ts";
import "./style.css";

function Card({
	session,
	host,
}: {
	session: ExtensionAgentSession;
	host: ExtensionClientHost;
}) {
	const git = host.usePullRequest(session.id);
	const [error, setError] = useState("");
	const pr = git.pullRequest;
	return (
		<article className="zb-card">
			<button
				type="button"
				className="zb-title"
				onClick={() => {
					setError("");
					void host
						.openSession(session.id)
						.catch((e) =>
							setError(
								e instanceof Error ? e.message : "Could not open session.",
							),
						);
				}}
			>
				{session.title || "Untitled session"} <span aria-hidden="true">↗</span>
			</button>
			<p>
				{session.projectName} · {session.providerId}
			</p>
			<p className="zb-model">{session.model}</p>
			<div className="zb-branch">{git.branch || "Branch unavailable"}</div>
			{git.loading ? (
				<p role="status">Loading branch status…</p>
			) : git.error ? (
				<p role="alert">{git.error}</p>
			) : pr && pr.state !== "none" ? (
				<>
					<p>
						<strong>
							PR #{pr.number} ·{" "}
							{pr.isDraft && pr.state === "open" ? "Draft" : pr.state}
						</strong>
						{git.stale ? " · cached" : ""}
					</p>
					<p>
						{pr.checksTotal === 0
							? "No checks reported"
							: `${pr.checksPassing} passing · ${pr.checksRunning} running · ${pr.checksFailing} failing`}
					</p>
				</>
			) : (
				<p>
					{git.stale ? "PR status unavailable or cached" : "No pull request"}
				</p>
			)}
			<time dateTime={session.updatedAt}>
				Updated {new Date(session.updatedAt).toLocaleString()}
			</time>
			{error && <p role="alert">{error}</p>}
		</article>
	);
}
export function Board({ host }: { host: ExtensionClientHost }) {
	const state = host.useSessions();
	const [query, setQuery] = useState("");
	const [project, setProject] = useState("");
	const [provider, setProvider] = useState("");
	const sessions = filterSessions(state.sessions, query, project, provider);
	const projects = [
		...new Map(
			state.sessions.map((s) => [s.projectId, s.projectName]),
		).entries(),
	];
	return (
		<section className="zb-board">
			<header>
				<div>
					<h1>Agent Board</h1>
					<p>Local agents and the pull requests on their branches.</p>
				</div>
				<span>{sessions.length} sessions</span>
			</header>
			<div className="zb-filters">
				<input
					className="h-7"
					aria-label="Search sessions"
					placeholder="Search tasks, projects, models…"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				<select
					className="h-7"
					aria-label="Project"
					value={project}
					onChange={(e) => setProject(e.target.value)}
				>
					<option value="">All projects</option>
					{projects.map(([id, name]) => (
						<option key={id} value={id}>
							{name}
						</option>
					))}
				</select>
				<select
					className="h-7"
					aria-label="Agent"
					value={provider}
					onChange={(e) => setProvider(e.target.value)}
				>
					<option value="">All agents</option>
					{[...new Set(state.sessions.map((s) => s.providerId))]
						.sort()
						.map((id) => (
							<option key={id}>{id}</option>
						))}
				</select>
			</div>
			{state.error && <p role="alert">{state.error}</p>}
			{state.loading ? (
				<p role="status">Loading local sessions…</p>
			) : (
				<>
					{state.stale && (
						<p role="status">
							Connection is not live. These are the last known states.
						</p>
					)}
					{sessions.length === 0 && (
						<p>
							No sessions match. Start a local conversation or clear the
							filters.
						</p>
					)}
					<div className="zb-columns">
						{columns.map((c) => (
							<Column
								key={`${c.id}:${query}:${project}:${provider}`}
								title={c.title}
								sessions={sessions.filter((s) => s.status === c.id)}
								host={host}
							/>
						))}
					</div>
				</>
			)}
			<footer>
				Status follows the agent automatically. Idle means the agent stopped
				working; it does not mean the task or PR is complete. Three cards per
				column are watched at a time.
			</footer>
		</section>
	);
}
function Column({
	title,
	sessions,
	host,
}: {
	title: string;
	sessions: readonly ExtensionAgentSession[];
	host: ExtensionClientHost;
}) {
	const [page, setPage] = useState(0);
	const last = Math.max(0, Math.ceil(sessions.length / 3) - 1);
	const current = Math.min(page, last);
	return (
		<section className="zb-column">
			<h2>
				{title}
				<span>{sessions.length}</span>
			</h2>
			{sessions.slice(current * 3, current * 3 + 3).map((s) => (
				<Card key={s.id} session={s} host={host} />
			))}
			{sessions.length === 0 && <p className="zb-empty">No sessions</p>}
			{last > 0 && (
				<nav>
					<button
						className="h-7"
						type="button"
						disabled={current === 0}
						onClick={() => setPage(current - 1)}
					>
						Previous
					</button>
					<span>
						{current + 1}/{last + 1}
					</span>
					<button
						className="h-7"
						type="button"
						disabled={current === last}
						onClick={() => setPage(current + 1)}
					>
						Next
					</button>
				</nav>
			)}
		</section>
	);
}
export default function setup(e: ExtensionClientContext) {
	const Panel = () => <Board host={e.host} />;
	e.addWorkspacePanel({
		id: "board",
		title: "Agent Board",
		icon: "package",
		Component: Panel,
	});
	e.addSurface("board", Panel);
	e.addSidebarItem({
		id: "board",
		title: "Agent Board",
		icon: "package",
		surfaceId: "board",
	});
	e.addCommand({
		id: "open",
		title: "Agent Board: Open",
		icon: "package",
		context: "global",
		run: (ctx) => ctx.openSurface("board"),
	});
	return () => {};
}
