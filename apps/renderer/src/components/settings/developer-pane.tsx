import "@zuse/i18n/english/settings";
import { HugeiconsIcon } from "@hugeicons/react";
import { message as uiMessage } from "@zuse/i18n";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	Alert01Icon,
	GitMergeIcon,
	GitPullRequestIcon,
	InformationCircleIcon,
	Loading02Icon,
	TaskDone01Icon,
	Upload01Icon,
	Wrench01Icon,
} from "@zuse/icons/solid-rounded";
import {
	GLASS_TONE_VARS,
	GLASS_TONES,
	GlassActionButton,
	GlassChip,
	type GlassTone,
} from "../glass-action.tsx";
import { toastManager } from "../ui/toast.tsx";

/**
 * Dev-only visual playground. Renders the accent palette + every state of
 * the top-bar workflow chip/button so we can tune colors without driving the
 * real surface (which requires a real git state + PR to exercise). Hidden in
 * production via the rail filter in `settings-page.tsx`.
 */
export function DeveloperPane(): React.ReactElement {
	return (
		<div className="flex flex-col gap-10">
			<PaletteSection />
			<ToastPlaygroundSection />
			<WorkflowStatesSection />
		</div>
	);
}

const EXTRA_TOKENS: ReadonlyArray<{ name: string; cssVar: string }> = [
	{ name: "lime", cssVar: "var(--lime)" },
	{ name: "background", cssVar: "var(--background)" },
	{ name: "muted", cssVar: "var(--muted)" },
	{ name: "border", cssVar: "var(--border)" },
];

function PaletteSection(): React.ReactElement {
	const { message: uiMessage } = useUiMessages(["settings"]);

	return (
		<section className="flex flex-col gap-3">
			<h2 className="text-xs font-semibold uppercase tracking-[0.07em] text-muted-foreground">
				{uiMessage("settings:developer_pane_accent_palette")}
			</h2>
			<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
				{GLASS_TONES.map((tone) => (
					<Swatch
						key={tone}
						name={`accent-${tone}`}
						cssVar={GLASS_TONE_VARS[tone]}
					/>
				))}
				{EXTRA_TOKENS.map((t) => (
					<Swatch key={t.name} name={t.name} cssVar={t.cssVar} />
				))}
			</div>
		</section>
	);
}

function Swatch({
	name,
	cssVar,
}: {
	name: string;
	cssVar: string;
}): React.ReactElement {
	return (
		<div className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted p-3">
			<div
				className="size-10 shrink-0 rounded-lg border border-white/8"
				style={{ backgroundColor: cssVar }}
			/>
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="text-sm font-medium text-foreground">{name}</span>
				<span className="truncate font-mono text-[10px] text-muted-foreground">
					{cssVar}
				</span>
			</div>
		</div>
	);
}

type WorkflowDemo = {
	label: string;
	tone: GlassTone;
	chip: string;
	action: { label: string; icon: React.ReactNode };
};

const WORKFLOW_DEMOS: ReadonlyArray<WorkflowDemo> = [
	{
		get label() {
			return uiMessage("settings:developer_pane_dirty");
		},
		tone: "amber",
		chip: "1 change",
		action: {
			get label() {
				return uiMessage("settings:developer_pane_commit_push");
			},
			icon: <HugeiconsIcon icon={Upload01Icon} />,
		},
	},
	{
		get label() {
			return uiMessage("settings:developer_pane_ahead");
		},
		tone: "pink",
		chip: "2 ahead",
		action: {
			get label() {
				return uiMessage("settings:developer_pane_create_pr");
			},
			icon: <HugeiconsIcon icon={GitPullRequestIcon} />,
		},
	},
	{
		get label() {
			return uiMessage("settings:developer_pane_open_pr");
		},
		tone: "green",
		chip: "#142",
		action: {
			get label() {
				return uiMessage("settings:developer_pane_merge");
			},
			icon: <HugeiconsIcon icon={GitMergeIcon} />,
		},
	},
	{
		get label() {
			return uiMessage("settings:developer_pane_open_pr_draft");
		},
		tone: "zinc",
		chip: "#142",
		action: {
			get label() {
				return uiMessage("settings:developer_pane_mark_ready");
			},
			icon: <HugeiconsIcon icon={GitMergeIcon} />,
		},
	},
	{
		get label() {
			return uiMessage("settings:developer_pane_open_pr_checks_failing");
		},
		tone: "red",
		chip: "#142",
		action: {
			get label() {
				return uiMessage("settings:developer_pane_fix_actions");
			},
			icon: <HugeiconsIcon icon={Wrench01Icon} />,
		},
	},
	{
		get label() {
			return uiMessage("settings:developer_pane_open_pr_conflicts");
		},
		tone: "red",
		chip: "#142",
		action: {
			get label() {
				return uiMessage("settings:developer_pane_resolve_conflicts");
			},
			icon: <HugeiconsIcon icon={Alert01Icon} />,
		},
	},
];

function noop(): void {}

function ToastPlaygroundSection(): React.ReactElement {
	const { message: uiMessage } = useUiMessages(["settings"]);

	return (
		<section className="flex flex-col gap-3">
			<h2 className="text-xs font-semibold uppercase tracking-[0.07em] text-muted-foreground">
				{uiMessage("settings:developer_pane_toast_playground")}
			</h2>
			<div className="grid gap-2 rounded-lg border border-border/60 bg-muted p-3 sm:grid-cols-2">
				<GlassActionButton
					tone="green"
					icon={<HugeiconsIcon icon={GitMergeIcon} />}
					label={uiMessage("settings:developer_pane_pr_merged")}
					onClick={() =>
						toastManager.add({
							type: "success",
							title: uiMessage(
								"settings:developer_pane_pull_request_142_merged",
							),
							description: uiMessage(
								"settings:developer_pane_toast_system_into_main",
							),
						})
					}
				/>
				<GlassActionButton
					tone="zinc"
					icon={<HugeiconsIcon icon={InformationCircleIcon} />}
					label={uiMessage("settings:developer_pane_pr_closed")}
					onClick={() =>
						toastManager.add({
							type: "info",
							title: uiMessage(
								"settings:developer_pane_pull_request_142_closed",
							),
							description: uiMessage(
								"settings:developer_pane_toast_system_into_main",
							),
						})
					}
				/>
				<GlassActionButton
					tone="red"
					icon={<HugeiconsIcon icon={Alert01Icon} />}
					label={uiMessage("settings:developer_pane_sidebar_error")}
					onClick={() =>
						toastManager.add({
							type: "error",
							title: uiMessage("settings:developer_pane_project_error"),
							description: uiMessage(
								"settings:developer_pane_could_not_load_projects_from_the_local_workspace",
							),
						})
					}
				/>
				<GlassActionButton
					tone="red"
					icon={<HugeiconsIcon icon={Alert01Icon} />}
					label={uiMessage("settings:developer_pane_action_failed")}
					onClick={() =>
						toastManager.add({
							type: "error",
							title: uiMessage("settings:developer_pane_merge_failed"),
							description: uiMessage(
								"settings:developer_pane_github_rejected_the_merge_because_required_checks_are_still_runni",
							),
						})
					}
				/>
				<GlassActionButton
					tone="pink"
					icon={<HugeiconsIcon icon={Loading02Icon} />}
					label={uiMessage("settings:developer_pane_loading")}
					onClick={() =>
						toastManager.add({
							type: "loading",
							title: uiMessage(
								"settings:developer_pane_removing_dirty_worktree",
							),
							description: uiMessage(
								"settings:developer_pane_discarding_local_changes_and_deleting_the_checkout",
							),
						})
					}
				/>
				<GlassActionButton
					tone="green"
					icon={<HugeiconsIcon icon={TaskDone01Icon} />}
					label={uiMessage("settings:developer_pane_success")}
					onClick={() =>
						toastManager.add({
							type: "success",
							title: uiMessage("settings:developer_pane_worktree_removed"),
							description: uiMessage(
								"settings:developer_pane_the_dirty_checkout_was_discarded_and_archived",
							),
						})
					}
				/>
			</div>
		</section>
	);
}

function WorkflowStatesSection(): React.ReactElement {
	const { message: uiMessage } = useUiMessages(["settings"]);

	return (
		<section className="flex flex-col gap-3">
			<h2 className="text-xs font-semibold uppercase tracking-[0.07em] text-muted-foreground">
				{uiMessage("settings:developer_pane_top_bar_workflow_states")}
			</h2>
			<div className="flex flex-col divide-y divide-border/40 overflow-hidden rounded-lg border border-border/60 bg-muted">
				{WORKFLOW_DEMOS.map((s) => (
					<div
						key={s.label}
						className="flex items-center justify-between gap-3 px-3 py-2.5"
					>
						<span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
							{s.label}
						</span>
						<div className="flex items-center gap-2">
							<GlassChip tone={s.tone}>{s.chip}</GlassChip>
							<GlassActionButton
								tone={s.tone}
								icon={s.action.icon}
								label={s.action.label}
								onClick={noop}
							/>
						</div>
					</div>
				))}
			</div>
		</section>
	);
}
