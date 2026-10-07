import "@zuse/i18n/english/settings";
import type {
	ReviewAvailability,
	ReviewFixContext,
	ReviewRun,
	ReviewRunPage,
} from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useAuth } from "../../hooks/use-auth.ts";
import { runCloudControl } from "../../lib/control-plane-client.ts";
import {
	rendererAccountSnapshot,
	subscribeRendererAccount,
} from "../../lib/renderer-account.ts";
import {
	rendererWorkspaceSnapshot,
	subscribeRendererWorkspace,
} from "../../lib/renderer-workspace.ts";
import {
	reviewCostLabel,
	reviewFixPrompt,
	reviewStateLabel,
} from "../../lib/review-presentation.ts";
import { useChatsStore } from "../../store/chats.ts";
import { useReviewDraftStore } from "../../store/review-draft.ts";
import { useReviewHandoffStore } from "../../store/review-handoff.ts";
import { useUiStore } from "../../store/ui.ts";
import { Button } from "../ui/button.tsx";
import { CloudSettingsGroup, CloudSettingsRow } from "./cloud-settings-ui.tsx";
import { ReviewRequestForm, ReviewSetupForm } from "./review-setup.tsx";

export function ReviewPane() {
	const account = useSyncExternalStore(
		subscribeRendererAccount,
		rendererAccountSnapshot,
	);
	const workspace = useSyncExternalStore(
		subscribeRendererWorkspace,
		rendererWorkspaceSnapshot,
	);
	return (
		<ReviewPaneContent
			key={`${account.epoch}:${workspace.key}:${workspace.epoch}`}
		/>
	);
}

function ReviewPaneContent() {
	const { message: m } = useMessages(["settings"]);
	const auth = useAuth();
	const [availability, setAvailability] = useState<ReviewAvailability | null>(
		null,
	);
	const [page, setPage] = useState<ReviewRunPage>({ items: [] });
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(false);
	const [busy, setBusy] = useState(false);
	const generation = useRef(0);
	const actionInFlight = useRef(false);
	const pending = useReviewHandoffStore((s) => s.pending);
	const [fix, setFix] = useState<ReviewFixContext | null>(null);
	const [fixError, setFixError] = useState(false);
	const [selected, setSelected] = useState<readonly string[]>([]);
	const [copied, setCopied] = useState(false);

	const load = useCallback(async () => {
		const request = ++generation.current;
		setLoading(true);
		setError(false);
		try {
			const [status, runs] = await Promise.all([
				runCloudControl((client) => client["review.coverage"]()),
				runCloudControl((client) => client["review.runs"]({})),
			]);
			if (request !== generation.current) return;
			setAvailability(status);
			setPage(runs);
		} catch {
			if (request === generation.current) setError(true);
		} finally {
			if (request === generation.current) setLoading(false);
		}
	}, []);
	useEffect(() => {
		if (auth.isSignedIn) void load();
		return () => {
			generation.current++;
		};
	}, [auth.isSignedIn, load]);
	useEffect(() => {
		if (
			!auth.isSignedIn ||
			!page.items.some((run) =>
				["queued", "provisioning", "reviewing", "publishing"].includes(
					run.state,
				),
			)
		)
			return;
		const timer = window.setInterval(() => {
			if (document.visibilityState === "visible") void load();
		}, 10_000);
		return () => window.clearInterval(timer);
	}, [auth.isSignedIn, page, load]);
	useEffect(() => {
		setFix(null);
		setFixError(false);
		setSelected([]);
		setCopied(false);
		if (!pending || !auth.isSignedIn) return;
		let current = true;
		void runCloudControl((client) =>
			client["review.fixContext"]({ id: pending.runId }),
		).then(
			(context) => {
				if (!current) return;
				if (
					pending.findingId &&
					!context.findings.some((finding) => finding.id === pending.findingId)
				) {
					setFixError(true);
					return;
				}
				setFix(context);
				setSelected(
					context.findings
						.filter(
							(finding) =>
								!pending.findingId || finding.id === pending.findingId,
						)
						.map((finding) => finding.id),
				);
			},
			() => {
				if (current) setFixError(true);
			},
		);
		return () => {
			current = false;
		};
	}, [pending, auth.isSignedIn]);

	const action = async (operation: () => Promise<unknown>) => {
		if (actionInFlight.current) return;
		actionInFlight.current = true;
		setBusy(true);
		setError(false);
		const current = generation.current;
		try {
			await operation();
			if (current === generation.current) await load();
		} catch {
			if (current === generation.current) setError(true);
		} finally {
			actionInFlight.current = false;
			if (current <= generation.current) setBusy(false);
		}
	};
	const more = async () => {
		if (!page.nextCursor || actionInFlight.current) return;
		actionInFlight.current = true;
		setBusy(true);
		const current = generation.current;
		try {
			const next = await runCloudControl((client) =>
				client["review.runs"]({ cursor: page.nextCursor }),
			);
			if (current !== generation.current) return;
			setPage((previous) => ({
				...next,
				items: [
					...previous.items,
					...next.items.filter(
						(item) =>
							!previous.items.some((existing) => existing.id === item.id),
					),
				],
			}));
		} catch {
			if (current === generation.current) setError(true);
		} finally {
			actionInFlight.current = false;
			if (current === generation.current) setBusy(false);
		}
	};

	if (!auth.isSignedIn)
		return (
			<CloudSettingsGroup title={m("settings:review_title")}>
				<CloudSettingsRow
					title={m("settings:review_sign_in")}
					action={
						<Button
							className="h-7"
							disabled={auth.isLoading || auth.signingIn}
							onClick={() => void auth.signIn()}
						>
							{m("settings:review_sign_in_action")}
						</Button>
					}
				/>
			</CloudSettingsGroup>
		);
	return (
		<div className="flex flex-col gap-4">
			{pending && (
				<CloudSettingsGroup
					title={m("settings:review_fix")}
					description={m("settings:review_fix_detail")}
					action={
						<Button
							className="h-7"
							variant="ghost"
							onClick={() => useReviewHandoffStore.getState().clear()}
						>
							{m("settings:review_clear")}
						</Button>
					}
				>
					{fixError ? (
						<p role="alert" className="px-3 py-2 text-xs">
							{m("settings:review_fix_unavailable")}
						</p>
					) : fix === null ? (
						<p role="status" className="px-3 py-2 text-xs">
							{m("settings:review_loading")}
						</p>
					) : (
						<div className="space-y-3 px-3 py-2 text-xs">
							<p>
								{fix.repositoryFullName} #{fix.pullNumber} ·{" "}
								<code>{fix.snapshot.headSha.slice(0, 8)}</code>
							</p>
							{fix.snapshot.headSha !== fix.currentHeadSha && (
								<p role="status">{m("settings:review_head_changed")}</p>
							)}
							<p>{m("settings:review_select_all")}</p>
							{fix.findings.map((finding) => (
								<label key={finding.id} className="flex items-start gap-2 py-1">
									<input
										type="checkbox"
										checked={selected.includes(finding.id)}
										onChange={(event) => {
											setCopied(false);
											setSelected((ids) =>
												event.target.checked
													? [...ids, finding.id]
													: ids.filter((id) => id !== finding.id),
											);
										}}
									/>
									<span>
										<strong>{finding.title}</strong>
										<span className="mt-1 block text-muted-foreground">
											{finding.explanation}
										</span>
									</span>
								</label>
							))}
							<div className="flex flex-wrap gap-2">
								<Button
									className="h-7"
									disabled={selected.length === 0}
									onClick={() => {
										useReviewDraftStore
											.getState()
											.stage({ runId: fix.runId, findingIds: selected });
										useChatsStore.getState().select(null);
										useUiStore.getState().setView("chat");
									}}
								>
									{m("settings:review_continue")}
								</Button>
								<Button
									className="h-7"
									variant="ghost"
									disabled={selected.length === 0}
									onClick={() => {
										void navigator.clipboard
											.writeText(reviewFixPrompt(fix, selected))
											.then(
												() => setCopied(true),
												() => setError(true),
											);
									}}
								>
									{m("settings:review_copy")}
								</Button>
							</div>
							{copied && <p role="status">{m("settings:review_copied")}</p>}
						</div>
					)}
				</CloudSettingsGroup>
			)}
			<CloudSettingsGroup
				title={m("settings:review_coverage")}
				description={m("settings:review_connect_detail")}
				action={
					<Button
						className="h-7"
						variant="ghost"
						disabled={loading || busy}
						onClick={() => void load()}
					>
						{m("settings:review_refresh")}
					</Button>
				}
			>
				{error && (
					<p role="alert" className="px-3 py-2 text-xs text-destructive">
						{m("settings:review_error")}
					</p>
				)}
				{loading && availability === null ? (
					<p role="status" className="px-3 py-2 text-xs">
						{m("settings:review_loading")}
					</p>
				) : (
					availability && (
						<>
							{!availability.available && (
								<CloudSettingsRow
									title={m("settings:review_unavailable")}
									description={[
										m("settings:review_unavailable_detail"),
										availability.reason,
										...availability.providers
											.filter((provider) => !provider.available)
											.map(
												(provider) =>
													`${provider.provider}: ${provider.reasons.join(", ")}`,
											),
									]
										.filter(Boolean)
										.join(" · ")}
								/>
							)}
							{availability.enrollments.length === 0 ? (
								<CloudSettingsRow title={m("settings:review_not_enabled")} />
							) : (
								availability.enrollments.map((enrollment) => (
									<CloudSettingsRow
										key={enrollment.id}
										title={enrollment.repositoryFullName}
										description={`${m(enrollment.kind === "personal" ? "settings:review_personal" : "settings:review_shared")} · ${m(enrollment.enabled ? "settings:review_enabled" : "settings:review_disabled")}`}
										action={
											enrollment.enabled && (
												<Button
													className="h-7"
													variant="ghost"
													disabled={busy}
													onClick={() => {
														if (
															window.confirm(
																m("settings:review_disable_confirm"),
															)
														)
															void action(() =>
																runCloudControl((client) =>
																	client["review.disable"]({
																		id: enrollment.id,
																	}),
																),
															);
													}}
												>
													{m("settings:review_disable")}
												</Button>
											)
										}
									/>
								))
							)}
							<p className="px-3 py-2 text-[11px] text-muted-foreground">
								{m("settings:review_routing_notice")}
							</p>
						</>
					)
				)}
			</CloudSettingsGroup>
			{availability && (
				<>
					<ReviewSetupForm
						availability={availability}
						busy={busy}
						onAction={action}
					/>
					<ReviewRequestForm
						availability={availability}
						busy={busy}
						onAction={action}
					/>
				</>
			)}
			<CloudSettingsGroup
				title={m("settings:review_history")}
				description={m("settings:review_charge_notice")}
			>
				{!loading && !error && page.items.length === 0 && (
					<p className="px-3 py-2 text-xs text-muted-foreground">
						{m("settings:review_empty")}
					</p>
				)}
				{page.items.map((run) => (
					<ReviewRunRow
						key={run.id}
						run={run}
						busy={busy}
						canRetry={availability?.available === true}
						onCancel={() =>
							void action(() =>
								runCloudControl((client) =>
									client["review.cancel"]({ id: run.id }),
								),
							)
						}
						onRetry={() => {
							if (window.confirm(m("settings:review_retry_confirm")))
								void action(() =>
									runCloudControl((client) =>
										client["review.retry"]({ id: run.id }),
									),
								);
						}}
					/>
				))}
				{page.nextCursor && (
					<Button
						className="m-2 h-7"
						variant="ghost"
						disabled={busy || loading}
						onClick={() => void more()}
					>
						{m("settings:review_load_more")}
					</Button>
				)}
			</CloudSettingsGroup>
		</div>
	);
}

function ReviewRunRow({
	run: summary,
	busy,
	canRetry,
	onCancel,
	onRetry,
}: {
	run: ReviewRun;
	busy: boolean;
	canRetry: boolean;
	onCancel: () => void;
	onRetry: () => void;
}) {
	const { message: m } = useMessages(["settings"]);
	const [expanded, setExpanded] = useState(false);
	const [detail, setDetail] = useState<ReviewRun | null>(null);
	const [detailError, setDetailError] = useState(false);
	useEffect(() => {
		setDetail(null);
		setDetailError(false);
		if (!expanded) return;
		let current = true;
		void runCloudControl((client) =>
			client["review.get"]({ id: summary.id }),
		).then(
			(value) => {
				if (current) setDetail(value);
			},
			() => {
				if (current) setDetailError(true);
			},
		);
		return () => {
			current = false;
		};
	}, [expanded, summary.id, summary.updatedAtMs]);
	const run = detail ?? summary;
	const active = ["queued", "provisioning", "reviewing", "publishing"].includes(
		run.state,
	);
	return (
		<CloudSettingsRow
			title={`${run.repositoryFullName} #${run.pullNumber}`}
			description={`${reviewStateLabel(run.state)} · ${reviewCostLabel(run)}`}
			action={
				<Button
					className="h-7"
					variant="ghost"
					disabled={busy || (!active && !canRetry)}
					onClick={active ? onCancel : onRetry}
				>
					{m(active ? "settings:review_cancel" : "settings:review_retry")}
				</Button>
			}
		>
			{run.result && (
				<p className="text-[11px] text-muted-foreground">
					{m("settings:review_coverage_count", {
						reviewed: run.result.coverage.reviewedFiles,
						eligible: run.result.coverage.eligibleFiles,
						excluded: run.result.coverage.excludedFiles,
					})}
				</p>
			)}
			<details
				className="mt-1 text-xs"
				onToggle={(event) => setExpanded(event.currentTarget.open)}
			>
				<summary className="cursor-pointer text-muted-foreground">
					{m("settings:review_details")}
				</summary>
				<div className="space-y-1 py-2">
					{expanded && detail === null && (
						<p role={detailError ? "alert" : "status"}>
							{m(
								detailError
									? "settings:review_fix_unavailable"
									: "settings:review_loading",
							)}
						</p>
					)}
					<p>
						{m("settings:review_created", {
							time: new Date(run.createdAtMs).toLocaleString(),
						})}
					</p>
					{run.blockedReason && (
						<p>{m("settings:review_reason", { reason: run.blockedReason })}</p>
					)}
					{run.result?.reason && (
						<p>{m("settings:review_reason", { reason: run.result.reason })}</p>
					)}
					{run.result?.coverage.contextLimited && (
						<p>{m("settings:review_context_limited")}</p>
					)}
					{run.result && run.result.coverage.unreviewedPaths.length > 0 && (
						<details>
							<summary>{m("settings:review_unreviewed")}</summary>
							<ul>
								{run.result.coverage.unreviewedPaths.map((path) => (
									<li className="break-all" key={path}>
										{path}
									</li>
								))}
							</ul>
						</details>
					)}
					<p>
						<code>
							{run.baseSha.slice(0, 8)}…{run.headSha.slice(0, 8)}
						</code>
					</p>
					<p>
						{m("settings:review_worker")}: {run.worker.provider} ·{" "}
						{run.worker.size}
					</p>
					<p>
						{m("settings:review_runtime", {
							minutes: run.worker.maxRuntimeMs / 60_000,
						})}
					</p>

					{run.result && (
						<div className="space-y-2 py-2">
							<p className="font-medium">{m("settings:review_checks")}</p>
							<p className="text-muted-foreground">
								{m("settings:review_checks_detail")}
							</p>
							{run.result.checksReason && <p>{run.result.checksReason}</p>}
							{(run.result.checks ?? []).length === 0 && (
								<p>{m("settings:review_checks_none")}</p>
							)}
							{run.result.checks?.map((check, index) => (
								<details key={`${check.script}:${index}`}>
									<summary className="cursor-pointer break-all">
										{check.script} · {m("settings:review_check_base")}:{" "}
										{m(`settings:review_check_${check.base.status}`)} ·{" "}
										{m("settings:review_check_head")}:{" "}
										{m(`settings:review_check_${check.head.status}`)}
									</summary>
									<p className="break-all py-1 font-mono">{check.command}</p>
									{(["base", "head"] as const).map((side) => (
										<div key={side}>
											<p>
												{m(`settings:review_check_${side}`)}
												{check[side].exitCode !== undefined
													? ` · ${m("settings:review_exit_code", { code: check[side].exitCode })}`
													: ""}
											</p>
											<pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-muted-foreground">
												{check[side].output}
											</pre>
										</div>
									))}
								</details>
							))}
						</div>
					)}
					{run.result?.findings.map((finding) => (
						<div key={finding.id} className="py-1">
							<p className="font-medium">
								{finding.severity} · {finding.title}
							</p>
							<p className="break-all text-muted-foreground">
								{finding.location.path}:{finding.location.startLine}–
								{finding.location.endLine}
							</p>
							<p className="text-muted-foreground">{finding.explanation}</p>
							<p>
								{m("settings:review_trigger")}: {finding.trigger}
							</p>
							<p>
								{m("settings:review_consequence")}: {finding.consequence}
							</p>
							<details>
								<summary>{m("settings:review_evidence")}</summary>
								{finding.evidence.map((evidence, index) => (
									<div key={`${evidence.path}:${evidence.startLine}:${index}`}>
										<p className="break-all">
											{evidence.path}:{evidence.startLine}
										</p>
										<pre className="whitespace-pre-wrap break-all text-muted-foreground">
											{evidence.quote}
										</pre>
									</div>
								))}
							</details>
							<Button
								className="mt-1 h-7"
								variant="ghost"
								onClick={() =>
									useReviewHandoffStore
										.getState()
										.accept({ runId: run.id, findingId: finding.id })
								}
							>
								{m("settings:review_fix")}
							</Button>
						</div>
					))}
					{run.result?.status === "completed" &&
						run.result.findings.length === 0 && (
							<p>{m("settings:review_no_findings")}</p>
						)}
					{run.result?.status === "partial" && (
						<p>{m("settings:review_partial")}</p>
					)}
				</div>
			</details>
		</CloudSettingsRow>
	);
}
