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
		action: "list" | "add" | "connect" | "remove" | "refresh",
		id = "",
		selectedProvider = provider,
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
						: action === "connect"
							? "Connecting… Allow Keychain access if macOS asks."
							: "Loading…",
				);
				const data = await invoke.current(
					quotaRpc,
					{
						action,
						id: accountId,
						label: action === "connect" ? "" : label.trim(),
						provider: selectedProvider,
						credentialPath: path,
					},
					{ signal: controller.signal },
				);
				if (!controller.signal.aborted) {
					setAccounts(data);
					if (action === "add" || action === "connect") {
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
	const cards = [
		...(["codex", "claude"] as const).map(
			(provider) =>
				accounts.find(
					(row) =>
						row.account.provider === provider && row.account.usesCurrentLogin,
				) ?? { provider },
		),
		...accounts.filter((row) => !row.account.usesCurrentLogin),
	];
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
								onClick={() => void run("refresh")}
							>
								Refresh all
							</button>
						</div>
					)}
				</header>

				{adding && (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void run("add");
						}}
					>
						<h2>Add a separate account</h2>
						<p>
							Use a separate CLI credential file for each additional account.
						</p>
						<div className="zq-form">
							<label>
								Provider
								<select
									className="h-7"
									value={provider}
									onChange={(event) => {
										const p =
											event.target.value === "claude" ? "claude" : "codex";
										setProvider(p);
										setPath(defaultPath(p));
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
									value={label}
									maxLength={80}
									placeholder="Work, personal…"
									onChange={(event) => setLabel(event.target.value)}
								/>
							</label>
							<label className="zq-path">
								Credential file
								<input
									className="h-7"
									value={path}
									spellCheck={false}
									onChange={(event) => setPath(event.target.value)}
								/>
							</label>
						</div>
						<div className="zq-actions">
							<button
								className="h-7 zq-primary"
								disabled={busy || !path.trim()}
								type="submit"
							>
								Connect account
							</button>
							<button
								className="h-7"
								type="button"
								disabled={busy}
								onClick={() => setAdding(false)}
							>
								Cancel
							</button>
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
								void run("list");
							}}
						>
							Cancel
						</button>
					</p>
				)}
				<div className="zq-grid">
					{cards.map((row) =>
						!("account" in row) ? (
							<article className="zq-connect" key={row.provider}>
								<h2>{row.provider === "codex" ? "Codex" : "Claude Code"}</h2>
								<p>See the remaining allowance for your current login.</p>
								<button
									className="h-7 zq-primary"
									type="button"
									disabled={busy}
									onClick={() => void run("connect", "", row.provider)}
								>
									Connect {row.provider === "codex" ? "Codex" : "Claude Code"}
								</button>
							</article>
						) : (
							<article className="zq-account" key={row.account.id}>
								<header>
									<div>
										<h2>{row.account.label}</h2>
										<p>
											{row.account.provider === "claude"
												? "Claude Code"
												: "Codex"}
											{row.plan ? ` · ${row.plan}` : ""}
											{row.account.usesCurrentLogin ? " · Current login" : ""}
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
										{row.fetchedAt
											? " Showing the last successful reading."
											: ""}
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
						),
					)}
				</div>

				{!adding && (
					<button
						className="h-7 zq-subtle"
						type="button"
						disabled={busy}
						onClick={() => setAdding(true)}
					>
						Add a separate account…
					</button>
				)}
				<p className="zq-help">
					Reads your existing CLI logins. macOS may ask you to allow Keychain
					access.
				</p>
				<details className="zq-details">
					<summary>Connection details</summary>
					<p>
						Current-login cards follow the account signed into that CLI.
						Separate accounts use their own credential files.
					</p>
					<p>
						Quota is fetched directly from each provider when you connect or
						refresh. Credentials stay out of the UI. This extension does not
						switch accounts, renew logins, or use Zuse’s quota collector.
					</p>
					<p>
						Refresh is limited to once per minute per account. Removing a card
						leaves your login untouched.
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
