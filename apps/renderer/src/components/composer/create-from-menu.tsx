import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowDown01Icon,
	CancelCircleIcon,
	CheckmarkCircle01Icon,
	CircleDashedIcon,
	GitBranchIcon,
	GitPullRequestIcon,
	Progress03Icon,
	RecordIcon,
	Search01Icon,
} from "@hugeicons-pro/core-solid-rounded";
import type {
	FolderId,
	GitBranchInfo,
	GitIssueSummary,
	GitPrSummary,
	LinearConnection,
	LinearIssueSummary,
	WorktreeId,
} from "@zuse/contracts";
import { Effect } from "effect";
import { useEffect, useMemo, useRef, useState } from "react";

import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "~/components/ui/avatar.tsx";
import { Button } from "~/components/ui/button.tsx";
import { overlaySurface } from "~/components/ui/overlay-surface";
import { PopoverPrimitive } from "~/components/ui/popover";
import { getRpcClient } from "~/lib/rpc-client.ts";
import { cn } from "~/lib/utils";
import { useUiStore } from "~/store/ui.ts";

/**
 * What the "Create from…" picker hands back to the Chat Lander. PRs + branches
 * carry `existingWorktreeId` when a worktree is already checked out on that
 * branch ("In use") so the lander can reuse it instead of a second checkout.
 * Issues have no branch — they turn into an attached `.md` + a prefilled prompt.
 */
export type CreateFromSelection =
	| {
			readonly kind: "pr";
			readonly number: number;
			readonly headRefName: string;
			readonly title: string;
			readonly existingWorktreeId: WorktreeId | null;
	  }
	| {
			readonly kind: "branch";
			readonly branch: string;
			readonly remote: string | null;
			readonly existingWorktreeId: WorktreeId | null;
	  }
	| {
			readonly kind: "issue";
			readonly number: number;
			readonly title: string;
	  }
	| {
			readonly kind: "linear";
			readonly issues: ReadonlyArray<LinearIssueSummary>;
			readonly mode: "combined" | "separate";
	  };

type Tab = "prs" | "branches" | "issues" | "linear";

interface Row {
	readonly key: string;
	readonly icon: typeof GitPullRequestIcon;
	readonly lead: string;
	readonly label: string;
	readonly inUse: boolean;
	readonly selection: CreateFromSelection;
	readonly haystack: string;
}

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
	{ id: "prs", label: "PRs" },
	{ id: "branches", label: "Branches" },
	{ id: "issues", label: "Issues" },
	{ id: "linear", label: "Linear" },
];

const linearStateIcon = (stateType: string) => {
	switch (stateType) {
		case "started":
			return Progress03Icon;
		case "completed":
			return CheckmarkCircle01Icon;
		case "canceled":
			return CancelCircleIcon;
		case "backlog":
		case "triage":
			return CircleDashedIcon;
		default:
			return RecordIcon;
	}
};

const assigneeInitials = (name: string): string =>
	name
		.trim()
		.split(/\s+/u)
		.slice(0, 2)
		.map((part) => part[0] ?? "")
		.join("")
		.toUpperCase();

export interface CreateFromMenuProps {
	readonly folderId: FolderId | null;
	readonly onSelect: (selection: CreateFromSelection) => void;
}

/**
 * The "Create from…" control shown in the draft composer's header. Opens a
 * searchable, tabbed popover (PRs / Branches / Issues) sourced from `gh` +
 * `git`. Selecting a row reports it up to the Chat Lander, which starts the
 * chat against that PR/branch (checkout) or issue (attach + prefill).
 */
export function CreateFromMenu({ folderId, onSelect }: CreateFromMenuProps) {
	const setView = useUiStore((state) => state.setView);
	const setSettingsSection = useUiStore((state) => state.setSettingsSection);
	const [open, setOpen] = useState(false);
	const [tab, setTab] = useState<Tab>("prs");
	const [query, setQuery] = useState("");
	const [highlight, setHighlight] = useState(0);

	const [prs, setPrs] = useState<ReadonlyArray<GitPrSummary> | null>(null);
	const [branches, setBranches] = useState<ReadonlyArray<GitBranchInfo> | null>(
		null,
	);
	const [issues, setIssues] = useState<ReadonlyArray<GitIssueSummary> | null>(
		null,
	);
	const [linearConnections, setLinearConnections] =
		useState<ReadonlyArray<LinearConnection> | null>(null);
	const [linearIssues, setLinearIssues] =
		useState<ReadonlyArray<LinearIssueSummary> | null>(null);
	const [linearError, setLinearError] = useState<string | null>(null);
	const [linearWorkspaceId, setLinearWorkspaceId] = useState("");
	const [selectedLinear, setSelectedLinear] = useState<
		ReadonlyMap<string, LinearIssueSummary>
	>(new Map());
	const [separateLinearThreads, setSeparateLinearThreads] = useState(false);
	const [worktreesLoadedForOpen, setWorktreesLoadedForOpen] = useState(false);
	// branch name → worktreeId, for the "In use" badge + reuse behaviour.
	const [worktreeByBranch, setWorktreeByBranch] = useState<
		ReadonlyMap<string, WorktreeId>
	>(new Map());

	const inputRef = useRef<HTMLInputElement | null>(null);

	const openIntegrations = () => {
		setOpen(false);
		setSettingsSection({ kind: "integrations" });
		setView("settings");
	};

	useEffect(() => {
		setPrs(null);
		setBranches(null);
		setIssues(null);
		setWorktreeByBranch(new Map());
		setWorktreesLoadedForOpen(false);
	}, [folderId]);

	useEffect(() => {
		if (!open || tab !== "linear") return;
		let cancelled = false;
		setLinearIssues(null);
		setLinearError(null);
		const timer = window.setTimeout(
			() => {
				void (async () => {
					try {
						const client = await getRpcClient();
						if (linearConnections === null) {
							const connections = await Effect.runPromise(
								client["linear.listConnections"]({}),
							);
							if (!cancelled) setLinearConnections(connections);
						}
						const result = await Effect.runPromise(
							client["linear.listIssues"]({
								...(query.trim() === "" ? {} : { query: query.trim() }),
								...(linearWorkspaceId === ""
									? {}
									: { workspaceIds: [linearWorkspaceId] }),
							}),
						);
						if (!cancelled) {
							setLinearIssues(result.issues);
							setLinearError(null);
						}
					} catch (cause) {
						if (!cancelled) {
							setLinearIssues([]);
							setLinearError(
								cause instanceof Error
									? cause.message
									: "Could not search Linear issues.",
							);
						}
					}
				})();
			},
			query.trim() === "" ? 0 : 250,
		);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [open, tab, query, linearWorkspaceId, linearConnections]);

	useEffect(() => {
		if (!open) {
			setWorktreesLoadedForOpen(false);
			setQuery("");
		}
	}, [open]);

	// Load the active tab's data whenever the popover opens or the tab changes.
	// The worktree map is needed by all tabs, but it only changes outside this
	// picker, so avoid refetching it on every tab switch.
	useEffect(() => {
		if (!open || folderId === null) return;
		let cancelled = false;
		void (async () => {
			try {
				const client = await getRpcClient();
				if (!worktreesLoadedForOpen) {
					const wts = await Effect.runPromise(
						client["worktree.list"]({ projectId: folderId }),
					).catch(() => []);
					if (cancelled) return;
					const map = new Map<string, WorktreeId>();
					for (const wt of wts) map.set(wt.branch, wt.id);
					setWorktreeByBranch(map);
					setWorktreesLoadedForOpen(true);
				}
				if (tab === "prs" && prs === null) {
					const rows = await Effect.runPromise(
						client["git.listPrs"]({ folderId }),
					).catch(() => []);
					if (!cancelled) setPrs(rows);
				} else if (tab === "branches" && branches === null) {
					const rows = await Effect.runPromise(
						client["git.branches"]({ folderId }),
					).catch(() => []);
					if (!cancelled) setBranches(rows);
				} else if (tab === "issues" && issues === null) {
					const rows = await Effect.runPromise(
						client["git.listIssues"]({ folderId }),
					).catch(() => []);
					if (!cancelled) setIssues(rows);
				}
			} catch {
				// Non-fatal: leave the tab empty.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [open, tab, folderId, prs, branches, issues, worktreesLoadedForOpen]);

	const loading =
		(tab === "prs" && prs === null) ||
		(tab === "branches" && branches === null) ||
		(tab === "issues" && issues === null) ||
		(tab === "linear" && linearIssues === null);

	const rows = useMemo<ReadonlyArray<Row>>(() => {
		if (tab === "prs") {
			return (prs ?? []).map((pr) => {
				const existing = worktreeByBranch.get(pr.headRefName) ?? null;
				return {
					key: `pr:${pr.number}`,
					icon: GitPullRequestIcon,
					lead: `#${pr.number}`,
					label: pr.title,
					inUse: existing !== null,
					selection: {
						kind: "pr",
						number: pr.number,
						headRefName: pr.headRefName,
						title: pr.title,
						existingWorktreeId: existing,
					},
					haystack: `${pr.number} ${pr.title} ${pr.author} ${pr.headRefName}`,
				};
			});
		}
		if (tab === "branches") {
			return (branches ?? [])
				.filter((b) => !b.current)
				.map((b) => {
					const existing = worktreeByBranch.get(b.name) ?? null;
					return {
						key: `br:${b.kind}:${b.name}`,
						icon: GitBranchIcon,
						lead: "",
						label: b.name,
						inUse: existing !== null,
						selection: {
							kind: "branch",
							branch: b.name,
							remote:
								b.kind === "remote" && b.remote !== null
									? (b.remote.split("/")[0] ?? null)
									: null,
							existingWorktreeId: existing,
						},
						haystack: b.name,
					};
				});
		}
		if (tab === "issues")
			return (issues ?? []).map((issue) => ({
				key: `is:${issue.number}`,
				icon: RecordIcon,
				lead: `#${issue.number}`,
				label: issue.title,
				inUse: false,
				selection: { kind: "issue", number: issue.number, title: issue.title },
				haystack: `${issue.number} ${issue.title} ${issue.author}`,
			}));
		return [];
	}, [tab, prs, branches, issues, worktreeByBranch]);

	const filtered = useMemo(() => {
		if (tab === "linear") return [];
		const q = query.trim().toLowerCase();
		if (q.length === 0) return rows;
		return rows.filter((r) => r.haystack.toLowerCase().includes(q));
	}, [rows, query, tab]);

	useEffect(() => setHighlight(0), [filtered]);

	const confirm = (row: Row) => {
		onSelect(row.selection);
		setOpen(false);
		setQuery("");
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (tab === "linear") {
			const issue = (linearIssues ?? [])[highlight];
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				const count = linearIssues?.length ?? 0;
				if (count > 0)
					setHighlight((value) =>
						e.key === "ArrowDown"
							? (value + 1) % count
							: (value - 1 + count) % count,
					);
			} else if ((e.key === "Enter" || e.key === " ") && issue !== undefined) {
				e.preventDefault();
				toggleLinear(issue);
			}
			return;
		}
		if (filtered.length === 0) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setHighlight((h) => (h + 1) % filtered.length);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setHighlight((h) => (h - 1 + filtered.length) % filtered.length);
		} else if (e.key === "Enter") {
			e.preventDefault();
			const row = filtered[highlight];
			if (row !== undefined) confirm(row);
		}
	};

	const linearKey = (issue: LinearIssueSummary) =>
		`${issue.workspaceId}:${issue.issueId}`;
	const toggleLinear = (issue: LinearIssueSummary) => {
		setSelectedLinear((current) => {
			const next = new Map(current);
			const key = linearKey(issue);
			if (next.has(key)) next.delete(key);
			else next.set(key, issue);
			return next;
		});
	};

	const confirmLinear = () => {
		if (selectedLinear.size === 0) return;
		onSelect({
			kind: "linear",
			issues: [...selectedLinear.values()],
			mode:
				selectedLinear.size > 1 && separateLinearThreads
					? "separate"
					: "combined",
		});
		setOpen(false);
		setSelectedLinear(new Map());
		setSeparateLinearThreads(false);
	};

	return (
		<PopoverPrimitive.Root
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) {
					requestAnimationFrame(() => inputRef.current?.focus());
				}
			}}
		>
			<PopoverPrimitive.Trigger
				className={cn(
					"flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] text-foreground transition-colors",
					"hover:bg-accent data-[popup-open]:bg-accent",
					folderId === null && "pointer-events-none opacity-50",
				)}
				aria-label="Create from an existing PR, branch, or issue tracker ticket"
			>
				<HugeiconsIcon
					icon={GitPullRequestIcon}
					className="size-3.5 text-muted-foreground"
				/>
				<span>Create from…</span>
				<HugeiconsIcon icon={ArrowDown01Icon} className="size-3 opacity-60" />
			</PopoverPrimitive.Trigger>
			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Positioner
					side="bottom"
					align="end"
					sideOffset={6}
					className="z-50"
				>
					<PopoverPrimitive.Popup
						className={cn(
							"flex w-[30rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden outline-none",
							overlaySurface,
						)}
						onKeyDown={onKeyDown}
					>
						<div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
							<HugeiconsIcon
								icon={Search01Icon}
								className="size-4 shrink-0 text-muted-foreground"
							/>
							<input
								ref={inputRef}
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder={
									tab === "branches"
										? "Search by name"
										: tab === "linear"
											? "Search ticker or title"
											: "Search by title, number, or author"
								}
								className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
							/>
						</div>
						<div className="flex items-center gap-1 border-b border-border/50 px-2 py-1.5">
							{TABS.map((t) => (
								<button
									key={t.id}
									type="button"
									onClick={() => {
										setTab(t.id);
										inputRef.current?.focus();
									}}
									className={cn(
										"rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors",
										tab === t.id
											? "bg-accent text-accent-foreground"
											: "text-muted-foreground hover:bg-muted hover:text-foreground",
									)}
								>
									{t.label}
								</button>
							))}
						</div>
						{tab === "linear" && (linearConnections?.length ?? 0) > 1 && (
							<div className="border-b border-border/50 px-3 py-2">
								<select
									aria-label="Filter by Linear workspace"
									value={linearWorkspaceId}
									onChange={(event) => setLinearWorkspaceId(event.target.value)}
									className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
								>
									<option value="">All workspaces</option>
									{linearConnections?.map((connection) => (
										<option
											key={connection.workspaceId}
											value={connection.workspaceId}
										>
											{connection.workspaceName}
										</option>
									))}
								</select>
							</div>
						)}
						<div className="max-h-80 min-h-24 overflow-y-auto py-1">
							{loading ? (
								<div className="px-3 py-6 text-center text-sm text-muted-foreground">
									Loading…
								</div>
							) : tab === "linear" && (linearConnections?.length ?? 0) === 0 ? (
								<div className="flex min-h-24 flex-col items-center justify-center gap-3 px-3 py-5 text-center">
									<p className="text-sm text-muted-foreground">
										Connect a workspace to start from Linear issues.
									</p>
									<Button
										type="button"
										variant="outline"
										onClick={openIntegrations}
									>
										Open integrations
									</Button>
								</div>
							) : tab === "linear" && linearError !== null ? (
								<div
									role="alert"
									className="px-3 py-6 text-center text-sm text-destructive"
								>
									{linearError}
								</div>
							) : tab === "linear" ? (
								(linearIssues ?? []).length === 0 ? (
									<div className="px-3 py-6 text-center text-sm text-muted-foreground">
										{query.trim() === ""
											? "No assigned open issues."
											: "No matching issues."}
									</div>
								) : (
									(linearIssues ?? []).map((issue, index) => {
										const checked = selectedLinear.has(linearKey(issue));
										const active = index === highlight;
										return (
											<label
												key={linearKey(issue)}
												onMouseEnter={() => setHighlight(index)}
												className={cn(
													"flex w-full items-center gap-3 px-3 py-2 text-left transition-colors",
													active ? "bg-accent" : "hover:bg-muted",
												)}
											>
												<input
													type="checkbox"
													checked={checked}
													onChange={() => toggleLinear(issue)}
													aria-label={`Select ${issue.identifier}: ${issue.title}`}
													className="sr-only"
												/>
												<span
													aria-hidden="true"
													className={cn(
														"grid size-4 shrink-0 place-items-center rounded border text-[10px]",
														checked
															? "border-primary bg-primary text-primary-foreground"
															: "border-border",
													)}
												>
													{checked ? "✓" : ""}
												</span>
												<span
													role="img"
													aria-label={`Status: ${issue.state || "Unknown"}`}
													title={issue.state || "Unknown status"}
													className={cn(
														"grid size-4 shrink-0 place-items-center",
														issue.stateColor === null &&
															"text-muted-foreground",
													)}
													style={
														issue.stateColor === null
															? undefined
															: { color: issue.stateColor }
													}
												>
													<HugeiconsIcon
														aria-hidden="true"
														icon={linearStateIcon(issue.stateType)}
														className="size-3.5"
													/>
												</span>
												<span className="shrink-0 font-mono text-xs text-muted-foreground">
													{issue.identifier}
												</span>
												<span className="min-w-0 flex-1 truncate text-sm">
													{issue.title}
												</span>
												{issue.assignee !== null && (
													<Avatar
														aria-label={`Assigned to ${issue.assignee}`}
														title={`Assigned to ${issue.assignee}`}
														className="size-5 border border-border/60"
													>
														{issue.assigneeAvatarUrl !== null && (
															<AvatarImage
																src={issue.assigneeAvatarUrl}
																alt=""
															/>
														)}
														<AvatarFallback className="text-[8px]">
															{assigneeInitials(issue.assignee)}
														</AvatarFallback>
													</Avatar>
												)}
												<span className="max-w-24 shrink-0 truncate text-xs text-muted-foreground">
													{issue.workspaceName}
												</span>
											</label>
										);
									})
								)
							) : filtered.length === 0 ? (
								<div className="px-3 py-6 text-center text-sm text-muted-foreground">
									{tab === "branches"
										? "No other branches."
										: `No ${tab === "prs" ? "open PRs" : "open issues"} found.`}
								</div>
							) : (
								filtered.map((row, i) => {
									const active = i === highlight;
									return (
										<button
											key={row.key}
											type="button"
											role="option"
											aria-selected={active}
											onMouseEnter={() => setHighlight(i)}
											onClick={() => confirm(row)}
											className={cn(
												"flex w-full items-center gap-3 px-3 py-2 text-left transition-colors",
												active ? "bg-accent" : "hover:bg-muted",
											)}
										>
											<HugeiconsIcon
												icon={row.icon}
												className="size-4 shrink-0 text-muted-foreground"
											/>
											{row.lead.length > 0 && (
												<span className="shrink-0 font-mono text-xs text-muted-foreground">
													{row.lead}
												</span>
											)}
											<span className="min-w-0 flex-1 truncate text-sm text-foreground">
												{row.label}
											</span>
											<span className="shrink-0 text-xs text-muted-foreground">
												{row.inUse ? "In use" : active ? "Select ↵" : ""}
											</span>
										</button>
									);
								})
							)}
						</div>
						{tab === "linear" && (
							<div className="flex items-center gap-2 border-t border-border/50 px-3 py-2">
								<span className="mr-auto text-xs text-muted-foreground">
									{selectedLinear.size} selected
								</span>
								{selectedLinear.size > 1 && (
									<label className="flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-md px-1 text-xs text-muted-foreground pointer-coarse:min-h-11">
										<input
											type="checkbox"
											checked={separateLinearThreads}
											onChange={(event) =>
												setSeparateLinearThreads(event.target.checked)
											}
											className="size-4 shrink-0 cursor-pointer accent-primary"
										/>
										<span>Separate threads</span>
									</label>
								)}
								<button
									type="button"
									disabled={selectedLinear.size === 0}
									onClick={confirmLinear}
									className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
								>
									Stage
								</button>
							</div>
						)}
					</PopoverPrimitive.Popup>
				</PopoverPrimitive.Positioner>
			</PopoverPrimitive.Portal>
		</PopoverPrimitive.Root>
	);
}
