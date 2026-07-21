import { HugeiconsIcon } from "@hugeicons/react";
import {
	Alert01Icon,
	GitMergeIcon,
	GitPullRequestIcon,
	InformationCircleIcon,
	Loading02Icon,
	TaskDone01Icon,
	Upload01Icon,
	Wrench01Icon,
} from "@hugeicons-pro/core-solid-rounded";
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
	return (
		<section className="flex flex-col gap-3">
			<h2 className="text-xs font-semibold uppercase tracking-[0.07em] text-muted-foreground">
				Accent palette
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
		label: "dirty",
		tone: "amber",
		chip: "1 change",
		action: {
			label: "Commit & push",
			icon: <HugeiconsIcon icon={Upload01Icon} />,
		},
	},
	{
		label: "ahead",
		tone: "pink",
		chip: "2 ahead",
		action: {
			label: "Create PR",
			icon: <HugeiconsIcon icon={GitPullRequestIcon} />,
		},
	},
	{
		label: "open-pr",
		tone: "green",
		chip: "#142",
		action: { label: "Merge", icon: <HugeiconsIcon icon={GitMergeIcon} /> },
	},
	{
		label: "open-pr · draft",
		tone: "zinc",
		chip: "#142",
		action: {
			label: "Mark ready",
			icon: <HugeiconsIcon icon={GitMergeIcon} />,
		},
	},
	{
		label: "open-pr · checks failing",
		tone: "red",
		chip: "#142",
		action: {
			label: "Fix actions",
			icon: <HugeiconsIcon icon={Wrench01Icon} />,
		},
	},
	{
		label: "open-pr · conflicts",
		tone: "red",
		chip: "#142",
		action: {
			label: "Resolve conflicts",
			icon: <HugeiconsIcon icon={Alert01Icon} />,
		},
	},
];

function noop(): void {}

function ToastPlaygroundSection(): React.ReactElement {
	return (
		<section className="flex flex-col gap-3">
			<h2 className="text-xs font-semibold uppercase tracking-[0.07em] text-muted-foreground">
				Toast playground
			</h2>
			<div className="grid gap-2 rounded-lg border border-border/60 bg-muted p-3 sm:grid-cols-2">
				<GlassActionButton
					tone="green"
					icon={<HugeiconsIcon icon={GitMergeIcon} />}
					label="PR merged"
					onClick={() =>
						toastManager.add({
							type: "success",
							title: "Pull request #142 merged",
							description: "toast-system into main",
						})
					}
				/>
				<GlassActionButton
					tone="zinc"
					icon={<HugeiconsIcon icon={InformationCircleIcon} />}
					label="PR closed"
					onClick={() =>
						toastManager.add({
							type: "info",
							title: "Pull request #142 closed",
							description: "toast-system into main",
						})
					}
				/>
				<GlassActionButton
					tone="red"
					icon={<HugeiconsIcon icon={Alert01Icon} />}
					label="Sidebar error"
					onClick={() =>
						toastManager.add({
							type: "error",
							title: "Project error",
							description: "Could not load projects from the local workspace.",
						})
					}
				/>
				<GlassActionButton
					tone="red"
					icon={<HugeiconsIcon icon={Alert01Icon} />}
					label="Action failed"
					onClick={() =>
						toastManager.add({
							type: "error",
							title: "Merge failed",
							description:
								"GitHub rejected the merge because required checks are still running.",
						})
					}
				/>
				<GlassActionButton
					tone="pink"
					icon={<HugeiconsIcon icon={Loading02Icon} />}
					label="Loading"
					onClick={() =>
						toastManager.add({
							type: "loading",
							title: "Removing dirty worktree...",
							description:
								"Discarding local changes and deleting the checkout.",
						})
					}
				/>
				<GlassActionButton
					tone="green"
					icon={<HugeiconsIcon icon={TaskDone01Icon} />}
					label="Success"
					onClick={() =>
						toastManager.add({
							type: "success",
							title: "Worktree removed",
							description: "The dirty checkout was discarded and archived.",
						})
					}
				/>
			</div>
		</section>
	);
}

function WorkflowStatesSection(): React.ReactElement {
	return (
		<section className="flex flex-col gap-3">
			<h2 className="text-xs font-semibold uppercase tracking-[0.07em] text-muted-foreground">
				Top-bar workflow states
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
