import type {
	ExtensionClientContext,
	ExtensionWorkspacePanelProps,
} from "@zuse/extension-sdk";
import { useEffect, useRef, useState } from "react";
import { type QuotaResult, quotaRpc } from "./contracts.ts";
import "./style.css";

const defaultPath = (provider: "codex" | "claude") =>
	provider === "codex" ? "~/.codex/auth.json" : "~/.claude/.credentials.json";

export function Panel(props: ExtensionWorkspacePanelProps) {
	const [accounts, setAccounts] = useState<readonly QuotaResult[]>([]);
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState("");
	const [error, setError] = useState("");
	const [label, setLabel] = useState("");
	const [provider, setProvider] = useState<"codex" | "claude">("codex");
	const [path, setPath] = useState(defaultPath("codex"));
	const [adding, setAdding] = useState(false);
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
					{
						action,
						id: accountId,
						label:
							label.trim() || (provider === "codex" ? "Codex" : "Claude Code"),
						provider,
						credentialPath: path,
					},
					{ signal: controller.signal },
				);
				if (!controller.signal.aborted) {
					setAccounts(data);
					if (action === "add") {
						setLabel("");
						setPath(defaultPath(provider));
						setAdding(false);
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
			<div className="zq-content">
				<header>
					<div>
						<h1>Account Quota</h1>
						<p>Your Claude Code and Codex allowances.</p>
					</div>
					{accounts.length > 0 && (
						<div className="zq-actions">
							<button
								className="h-7"
								type="button"
								disabled={busy}
								onClick={() => setAdding(!adding)}
							>
								Add account
							</button>
							<button
								className="h-7"
								type="button"
								disabled={busy}
								onClick={() => void run("refresh")}
							>
								Refresh all
							</button>
						</div>
					)}
				</header>
				{(accounts.length === 0 || adding) && (
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void run("add");
						}}
					>
						<h2>
							{accounts.length === 0
								? "Add your first account"
								: "Add another account"}
						</h2>
						<p>Choose a provider and its local credential file.</p>
						<div className="zq-form">
							<label>
								Provider
								<select
									className="h-7"
									value={provider}
									onChange={(e) => {
										const next =
											e.target.value === "claude" ? "claude" : "codex";
										setPath(defaultPath(next));
										setProvider(next);
									}}
								>
									<option value="codex">Codex</option>
									<option value="claude">Claude Code</option>
								</select>
							</label>
							<label>
								Account name
								<input
									className="h-7"
									placeholder="Personal, work… (optional)"
									value={label}
									maxLength={80}
									onChange={(e) => setLabel(e.target.value)}
								/>
							</label>
							<label className="zq-path">
								Credential file
								<input
									className="h-7"
									value={path}
									onChange={(e) => setPath(e.target.value)}
									spellCheck={false}
								/>
							</label>
						</div>
						{provider === "claude" && (
							<p className="zq-help">
								Requires a JSON credential file. Claude Code’s macOS Keychain
								login is not imported.
							</p>
						)}
						<div className="zq-actions">
							<button
								className="h-7 zq-primary"
								type="submit"
								disabled={busy || !path.trim()}
							>
								Add account
							</button>
							{accounts.length > 0 && (
								<button
									className="h-7"
									type="button"
									disabled={busy}
									onClick={() => setAdding(false)}
								>
									Cancel
								</button>
							)}
						</div>
					</form>
				)}

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
				<div className="zq-grid">
					{accounts.map((row) => (
						<article className="zq-account" key={row.account.id}>
							<header>
								<div>
									<h2>{row.account.label}</h2>
									<p>
										{row.account.provider === "claude"
											? "Claude Code"
											: "Codex"}
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
				<details className="zq-details">
					<summary>How account profiles work</summary>
					<p>
						Use a separate credential file for each account. This extension
						reads quota directly from the provider and does not change your
						active login.
					</p>
					<p>
						Tokens stay on this machine and are sent only to the selected
						provider. Sign-in and expired-token renewal happen outside this
						extension.
					</p>
					<p>
						Refresh is manual, at most once per account per minute. Removing a
						profile leaves its credential file untouched.
					</p>
				</details>
			</div>
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
