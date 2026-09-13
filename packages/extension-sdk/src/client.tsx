import { useEffect, useRef, useState } from "react";
import type {
	ExtensionAttachmentSnapshot,
	ExtensionWorkspacePanelProps,
} from "./contracts.ts";
import {
	type WorkspaceToolResult,
	workspaceToolRpc,
} from "./workspace-tool.ts";

const control = {
	height: 28,
	border: 0,
	borderRadius: 5,
	padding: "0 8px",
	background: "var(--muted)",
	color: "inherit",
	font: "inherit",
};
export function WorkspaceTool(
	props: ExtensionWorkspacePanelProps & {
		title: string;
		description: string;
		mode: "file" | "scan";
		statuses?: readonly string[];
	},
) {
	const [groupBy, setGroupBy] = useState("file");
	const [statusFilter, setStatusFilter] = useState("all");
	const [paths, setPaths] = useState<readonly string[]>([]);
	const [path, setPath] = useState("");
	const [query, setQuery] = useState("");
	const [items, setItems] = useState<readonly ExtensionAttachmentSnapshot[]>(
		[],
	);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [preview, setPreview] = useState<ExtensionAttachmentSnapshot | null>(
		null,
	);
	const [status, setStatus] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const request = useRef<AbortController | null>(null);
	const current = useRef(props);
	current.current = props;
	useEffect(() => {
		if (!props.workspacePath) return;
		const controller = new AbortController();
		request.current?.abort();
		request.current = controller;
		setPath("");
		setPaths([]);
		setQuery("");
		setItems([]);
		setPreview(null);
		setSelected(new Set());
		setError(null);
		setStatus("");
		setBusy(false);
		void current.current
			.invoke(
				workspaceToolRpc,
				{ action: "list", path: "", query: "", cursor: 0 },
				{ signal: controller.signal },
			)
			.then((result) => {
				if (!controller.signal.aborted) {
					setPaths(result.paths);
					setStatus(result.status);
				}
			})
			.catch((cause) => {
				if (!controller.signal.aborted) setError(String(cause));
			});
		return () => controller.abort();
	}, [props.workspacePath]);
	const load = async () => {
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		setBusy(true);
		setError(null);
		setItems([]);
		setSelected(new Set());
		setPreview(null);
		const found: ExtensionAttachmentSnapshot[] = [];
		let cursor = 0;
		try {
			do {
				const result: WorkspaceToolResult = await props.invoke(
					workspaceToolRpc,
					{
						action: props.mode === "scan" ? "scan" : "read",
						path,
						query,
						cursor,
					},
					{ signal: controller.signal },
				);
				if (controller.signal.aborted) return;
				found.push(...result.items);
				setItems([...found]);
				setStatus(
					`${result.status} ${result.progress}${result.truncated ? " Results truncated; narrow your selection." : ""}`,
				);
				if (result.nextCursor === null) break;
				cursor = result.nextCursor;
			} while (!controller.signal.aborted);
		} catch (cause) {
			if (!controller.signal.aborted)
				setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (request.current === controller) setBusy(false);
		}
	};
	const attach = async () => {
		const chosen = items.filter((item) => selected.has(item.id));
		if (!chosen.length) return;
		try {
			await props.attach({
				id: `selection-${Date.now()}`,
				title: `${props.title}: ${chosen.length} selected`,
				text: chosen
					.map(
						(item) =>
							`## ${item.title}\n${item.subtitle ?? ""}\n\n${item.text}`,
					)
					.join("\n\n---\n\n"),
			});
			setStatus("Attached to the composer. Review your prompt before sending.");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};
	const visibleItems = items.filter(
		(item) => statusFilter === "all" || item.metadata?.status === statusFilter,
	);
	const group = (item: ExtensionAttachmentSnapshot) =>
		props.mode === "scan"
			? ((groupBy === "tag" ? item.metadata?.tag : item.metadata?.file) ??
				"Results")
			: "Results";
	const groups = new Map<string, ExtensionAttachmentSnapshot[]>();
	for (const item of visibleItems) {
		const key = group(item);
		const values = groups.get(key) ?? [];
		values.push(item);
		groups.set(key, values);
	}
	return (
		<section
			style={{
				padding: 16,
				height: "100%",
				overflow: "auto",
				fontSize: 12,
				color: props.theme.colors.foreground,
			}}
			aria-label={props.title}
		>
			<h2 style={{ fontSize: 15, margin: "0 0 6px" }}>{props.title}</h2>
			<p style={{ opacity: 0.65, margin: "0 0 16px" }}>{props.description}</p>
			<div
				style={{
					display: "flex",
					gap: 8,
					flexWrap: "wrap",
					alignItems: "center",
				}}
			>
				{props.mode === "file" ? (
					<select
						className="h-7"
						aria-label="Workspace file"
						style={{ ...control, maxWidth: 360 }}
						value={path}
						onChange={(event) => setPath(event.target.value)}
					>
						<option value="">Select a workspace file…</option>
						{paths.map((value) => (
							<option key={value} value={value}>
								{value}
							</option>
						))}
					</select>
				) : null}
				{props.statuses ? (
					<select
						className="h-7"
						style={control}
						aria-label="Test status"
						value={statusFilter}
						onChange={(event) => setStatusFilter(event.target.value)}
					>
						<option value="all">All statuses</option>
						{props.statuses.map((status) => (
							<option key={status} value={status}>
								{status}
							</option>
						))}
					</select>
				) : null}
				{props.mode === "scan" ? (
					<select
						className="h-7"
						style={control}
						aria-label="Group findings"
						value={groupBy}
						onChange={(event) => setGroupBy(event.target.value)}
					>
						<option value="file">Group by file</option>
						<option value="tag">Group by tag</option>
					</select>
				) : null}
				<input
					className="h-7"
					aria-label="Filter results"
					placeholder="Filter by name, path, or text…"
					style={control}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
				<button
					type="button"
					className="h-7"
					style={control}
					disabled={busy || (props.mode === "file" && !path)}
					onClick={() => void load()}
				>
					{props.mode === "scan" ? "Scan workspace" : "Read file"}
				</button>
				{busy ? (
					<button
						type="button"
						className="h-7"
						style={control}
						onClick={() => {
							request.current?.abort();
							setBusy(false);
							setStatus("Cancelled. Partial results remain available.");
						}}
					>
						Cancel
					</button>
				) : null}
				<button
					type="button"
					className="h-7"
					style={control}
					disabled={!selected.size}
					onClick={() => void attach()}
				>
					Attach selected ({selected.size})
				</button>
			</div>
			{error ? (
				<p role="alert" style={{ color: "var(--destructive)" }}>
					{error}
				</p>
			) : null}
			<p role="status" style={{ opacity: 0.65 }}>
				{status || "Select the context you want your agent to see."}
			</p>
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "minmax(220px,1fr) minmax(240px,1fr)",
					gap: 16,
				}}
			>
				<div>
					{[...groups].map(([label, values]) => (
						<div key={label}>
							{props.mode === "scan" ? (
								<h3 style={{ fontSize: 12, opacity: 0.65, marginTop: 12 }}>
									{label}
								</h3>
							) : null}
							{values.map((item) => (
								<div
									key={item.id}
									style={{
										display: "flex",
										gap: 8,
										padding: "8px 4px",
										borderBottom: "1px solid var(--border)",
									}}
								>
									<input
										type="checkbox"
										aria-label={`Select ${item.title}`}
										checked={selected.has(item.id)}
										onChange={(event) =>
											setSelected((previous) => {
												const next = new Set(previous);
												if (event.target.checked) next.add(item.id);
												else next.delete(item.id);
												return next;
											})
										}
									/>
									<button
										type="button"
										style={{
											border: 0,
											background: "transparent",
											color: "inherit",
											textAlign: "left",
											font: "inherit",
											cursor: "pointer",
										}}
										onClick={() => setPreview(item)}
									>
										<strong>{item.title}</strong>
										<div style={{ opacity: 0.6, fontSize: 11, marginTop: 3 }}>
											{item.subtitle}
										</div>
									</button>
								</div>
							))}
						</div>
					))}
					{!busy && !items.length ? (
						<p style={{ opacity: 0.6 }}>No results loaded.</p>
					) : null}
				</div>
				<div>
					<p style={{ opacity: 0.6 }}>Context preview</p>
					<pre
						style={{
							fontFamily: "inherit",
							whiteSpace: "pre-wrap",
							overflowWrap: "anywhere",
							fontSize: 12,
							lineHeight: 1.6,
						}}
					>
						{preview?.text ??
							"Choose a result to inspect its contents before attaching."}
					</pre>
				</div>
			</div>
			<p style={{ opacity: 0.55, fontSize: 11, marginTop: 24 }}>
				Files are read locally. Selected context is sent to your chosen agent
				only when you submit the conversation.
			</p>
		</section>
	);
}
