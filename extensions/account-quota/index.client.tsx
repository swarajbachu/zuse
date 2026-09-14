import type {
	ExtensionClientContext,
	ExtensionWorkspacePanelProps,
} from "@zuse/extension-sdk";
import { useEffect, useRef, useState } from "react";
import { type QuotaResult, quotaRpc } from "./contracts.ts";
import "./style.css";
export function Panel(props: ExtensionWorkspacePanelProps) {
	const [accounts, setAccounts] = useState<readonly QuotaResult[]>([]);
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState("");
	const [error, setError] = useState("");
	const [label, setLabel] = useState("");
	const [provider, setProvider] = useState<"codex" | "claude">("codex");
	const [path, setPath] = useState("");
	const pending = useRef<AbortController | null>(null);
	const invoke = useRef(props.invoke);
	invoke.current = props.invoke;
	const run = async (
		action: "list" | "add" | "remove" | "refresh",
		id = "",
	) => {
		pending.current?.abort();
		const controller = new AbortController();
		pending.current = controller;
		setBusy(true);
		setError("");
		try {
			const ids =
				action === "refresh" && !id
					? accounts.map((row) => row.account.id)
					: [id];
			for (const [index, accountId] of ids.entries()) {
				controller.signal.throwIfAborted();
				setProgress(
					action === "refresh"
						? `Refreshing account ${index + 1} of ${ids.length}…`
						: "Loading profiles…",
				);
				const data = await invoke.current(
					quotaRpc,
					{ action, id: accountId, label, provider, credentialPath: path },
					{ signal: controller.signal },
				);
				if (!controller.signal.aborted) {
					setAccounts(data);
					if (action === "add") {
						setLabel("");
						setPath("");
					}
				}
			}
		} catch (e) {
			if (!controller.signal.aborted)
				setError(
					e instanceof Error ? e.message : "Could not load account profiles.",
				);
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	};
	useEffect(() => {
		setAccounts([]);
		void run("list");
		return () => {
			pending.current?.abort();
		};
	}, [props.projectId, props.workspacePath]);
	return (
		<section className="zq-panel">
			<header>
				<div>
					<h1>Account Quota</h1>
					<p>Claude Code and Codex · independent account profiles</p>
				</div>
				<button
					className="h-7"
					type="button"
					disabled={busy || accounts.length === 0}
					onClick={() => void run("refresh")}
				>
					Refresh all
				</button>
			</header>
			<p>
				Reads each profile directly from its provider. Does not use Zuse’s usage
				collector or change your active login.
			</p>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void run("add");
				}}
			>
				<h2>Connect an account profile</h2>
				<div className="zq-form">
					<input
						className="h-7"
						aria-label="Account label"
						placeholder="Work, personal, second account…"
						value={label}
						maxLength={80}
						onChange={(e) => setLabel(e.target.value)}
					/>
					<select
						className="h-7"
						aria-label="Provider"
						value={provider}
						onChange={(e) => setProvider(e.target.value as "codex" | "claude")}
					>
						<option value="codex">Codex</option>
						<option value="claude">Claude Code</option>
					</select>
					<input
						className="h-7"
						aria-label="Credential file path"
						placeholder={
							provider === "codex"
								? "~/.codex/auth.json"
								: "~/.claude/.credentials.json"
						}
						value={path}
						onChange={(e) => setPath(e.target.value)}
					/>
					<button
						className="h-7"
						type="submit"
						disabled={busy || !label.trim() || !path.trim()}
					>
						Add profile
					</button>
				</div>
				<p className="zq-help">
					Use a separate credential file for each account. Tokens stay on this
					machine and are sent only to the selected provider. Claude Code on
					macOS may keep its login in Keychain; a JSON credential-file profile
					is required here. This preview does not open a sign-in flow or renew
					expired logins.
				</p>
			</form>
			{error && <p role="alert">{error}</p>}
			{busy && (
				<p role="status">
					{progress}{" "}
					<button
						className="h-7"
						type="button"
						onClick={() => {
							pending.current?.abort();
							setBusy(false);
						}}
					>
						Cancel
					</button>
				</p>
			)}
			{!busy && accounts.length === 0 && (
				<div className="zq-empty">
					<h2>Compare your accounts before starting work</h2>
					<p>
						Add one or several profiles, then refresh their allowances. Account
						labels and file paths are saved by this extension.
					</p>
				</div>
			)}
			<div className="zq-grid">
				{accounts.map((row) => (
					<article className="zq-account" key={row.account.id}>
						<header>
							<div>
								<h2>{row.account.label}</h2>
								<p>
									{row.account.provider === "claude" ? "Claude Code" : "Codex"}
									{row.plan ? ` · ${row.plan}` : ""}
								</p>
							</div>
							<button
								className="h-7"
								type="button"
								disabled={busy}
								onClick={() => void run("refresh", row.account.id)}
							>
								Refresh
							</button>
						</header>
						{row.error && (
							<p role="alert">
								{row.error}
								{row.fetchedAt ? " Showing the last successful reading." : ""}
							</p>
						)}
						{row.windows.length === 0 && (
							<p>
								{row.error
									? "Quota unavailable."
									: "No reading yet. Refresh this account."}
							</p>
						)}
						{row.windows.map((w) => (
							<div className="zq-window" key={w.id}>
								<div>
									<span>{w.label}</span>
									<strong>
										{w.usedPercent === null
											? "Unknown"
											: `${Math.round(100 - w.usedPercent)}% left`}
									</strong>
								</div>
								{w.usedPercent !== null && (
									<progress
										aria-label={`${w.label} remaining`}
										value={100 - w.usedPercent}
										max={100}
									/>
								)}
								<p>
									{w.resetsAt
										? `Resets ${new Date(w.resetsAt).toLocaleString()}`
										: "Reset time unavailable"}
								</p>
							</div>
						))}
						<footer>
							<span>
								{row.fetchedAt
									? `Fetched ${new Date(row.fetchedAt).toLocaleString()}`
									: "Not fetched"}
							</span>
							<button
								className="h-7"
								type="button"
								disabled={busy}
								onClick={() => void run("remove", row.account.id)}
							>
								Remove
							</button>
						</footer>
					</article>
				))}
			</div>
			<p className="zq-help">
				Refresh is on demand, at most once per account per minute. Removing a
				profile leaves its credential file untouched. Quota endpoints can reject
				requests or change independently of Zuse.
			</p>
		</section>
	);
}
export default function setup(e: ExtensionClientContext) {
	e.addWorkspacePanel({
		id: "quota",
		title: "Account Quota",
		icon: "package",
		Component: Panel,
	});
	return () => {};
}
