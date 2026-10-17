import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { SimulatorRequirement } from "@zuse/contracts";
import { Cancel01Icon, Tick02Icon } from "@zuse/icons/solid-rounded";
import { type ReactNode, useEffect } from "react";
import type { useSimulatorActions } from "~/lib/simulator-client-bus.ts";
import {
	PLATFORM_LABELS,
	REQUIREMENT_LABELS,
	requirementSections,
	type SetupStep,
	type SetupStepState,
} from "~/lib/simulator-view.ts";
import { cn } from "~/lib/utils";
import { useUiStore } from "~/store/ui.ts";
import { DOCK_ICON_BUTTON_CLASS } from "../dock-panel/text.ts";
import { Button } from "../ui/button.tsx";
import { Spinner } from "../ui/spinner.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip.tsx";

/** Quiet device outline used as the simulator surface's only illustration. */
export function SimulatorGlyph({ className }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 28 44"
			fill="none"
			aria-hidden="true"
			className={cn("h-11 w-7 text-muted-foreground/70", className)}
		>
			<rect
				x="1"
				y="1"
				width="26"
				height="42"
				rx="6.5"
				stroke="currentColor"
				strokeWidth="1.5"
			/>
			<rect
				x="10.5"
				y="4"
				width="7"
				height="2.25"
				rx="1.125"
				fill="currentColor"
				opacity="0.6"
			/>
		</svg>
	);
}

export function StepIcon({ state }: { state: SetupStepState }) {
	if (state === "active")
		return <Spinner className="size-3.5 text-muted-foreground" />;
	return (
		<span
			className={cn(
				"flex size-3.5 shrink-0 items-center justify-center rounded-full",
				state === "done" && "bg-success/15 text-success",
				state === "failed" && "bg-destructive/15 text-destructive",
				state === "pending" && "ring-1 ring-inset ring-border",
			)}
		>
			{state === "done" ? (
				<HugeiconsIcon
					icon={Tick02Icon}
					className="size-2.5"
					strokeWidth={2.5}
				/>
			) : state === "failed" ? (
				<HugeiconsIcon
					icon={Cancel01Icon}
					className="size-2.5"
					strokeWidth={2.5}
				/>
			) : null}
		</span>
	);
}

/** Tonal list with no outer border, used for checklists in compact surfaces. */
export function SimulatorList({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}) {
	return (
		<ul
			className={cn(
				"flex flex-col rounded-lg bg-muted/40 px-3 py-1.5 text-xs",
				className,
			)}
		>
			{children}
		</ul>
	);
}

export type RequirementFix = {
	readonly run: (id: SimulatorRequirement["id"]) => void;
	/** Requirement whose fix request is in flight. */
	readonly pending: SimulatorRequirement["id"] | null;
};

/** One requirement: status, label, detail and, when the host can fix it, an action. */
export function RequirementRow({
	item,
	fix,
	className,
}: {
	item: SimulatorRequirement;
	fix?: RequirementFix;
	className?: string;
}) {
	const id = item.id;
	const running = item.fix?.running === true;
	const match = running ? item.detail.match(/(\d+(?:\.\d+)?)%/u) : null;
	const percent = match?.[1] ? Math.min(100, Number(match[1])) : null;
	return (
		<div className={cn("flex min-w-0 items-start gap-2.5 text-xs", className)}>
			<span className="flex h-6 items-center">
				<StepIcon state={running ? "active" : item.ok ? "done" : "failed"} />
			</span>
			<div className="min-w-0 flex-1">
				<div className="flex h-6 min-w-0 items-center justify-between gap-3">
					<span className="shrink-0 text-foreground">
						{REQUIREMENT_LABELS[id]}
					</span>
					{item.ok ? (
						<span className="truncate text-[11px] text-muted-foreground">
							{item.detail}
						</span>
					) : item.fix && !running && fix ? (
						<Button
							size="sm"
							variant="outline"
							loading={fix.pending === id}
							onClick={() => fix.run(id)}
						>
							{item.fix.label}
						</Button>
					) : null}
				</div>
				{running && percent !== null ? (
					<div className="mb-1 mt-0.5 h-1 overflow-hidden rounded-full bg-muted">
						<div
							className="h-full rounded-full bg-foreground/60 transition-[width] duration-500"
							style={{ width: `${percent}%` }}
						/>
					</div>
				) : null}
				{!item.ok ? (
					<p
						className={cn(
							"text-[11px] leading-4 text-muted-foreground tabular-nums",
							running && "truncate",
						)}
					>
						{item.detail}
					</p>
				) : null}
			</div>
		</div>
	);
}

/** Shown while the host's read-only check runs. */
export function RequirementsChecking({ className }: { className?: string }) {
	return (
		<div className={cn("flex h-8 items-center gap-2.5 text-xs", className)}>
			<StepIcon state="active" />
			<span className="text-muted-foreground">Checking this computer…</span>
		</div>
	);
}

/** Section label used when requirements cover more than one platform. */
export function RequirementSectionLabel({
	platform,
	className,
}: {
	platform: SimulatorRequirement["platform"];
	className?: string;
}) {
	return (
		<p
			className={cn(
				"text-[11px] font-medium text-muted-foreground/80",
				className,
			)}
		>
			{PLATFORM_LABELS[platform]}
		</p>
	);
}

export function RequirementList({
	requirements,
	fix,
	className,
}: {
	requirements: ReadonlyArray<SimulatorRequirement>;
	fix?: RequirementFix;
	className?: string;
}) {
	if (requirements.length === 0)
		return (
			<SimulatorList className={className}>
				<li>
					<RequirementsChecking />
				</li>
			</SimulatorList>
		);
	const sections = requirementSections(requirements);
	return (
		<SimulatorList className={className}>
			{sections.map((section) => (
				<li key={section.platform} className="pb-1 last:pb-0">
					{sections.length > 1 ? (
						<RequirementSectionLabel
							platform={section.platform}
							className="pt-1.5 pb-0.5"
						/>
					) : null}
					<ul>
						{section.items.map((item) => (
							<li key={item.id} className="py-1">
								<RequirementRow item={item} fix={fix} />
							</li>
						))}
					</ul>
				</li>
			))}
		</SimulatorList>
	);
}

export function StepList({ steps }: { steps: ReadonlyArray<SetupStep> }) {
	return (
		<SimulatorList>
			{steps.map((step) => (
				<li
					key={step.label}
					className={cn(
						"flex h-7 items-center gap-2.5",
						step.state === "pending" && "text-muted-foreground",
					)}
				>
					<StepIcon state={step.state} />
					<span className="truncate">{step.label}</span>
				</li>
			))}
		</SimulatorList>
	);
}

/** Centered column for the pane's non-viewer states. */
export function SimulatorStage({
	title,
	description,
	children,
}: {
	title: string;
	description?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
			<div className="m-auto flex w-full max-w-80 flex-col gap-5 px-5 py-8">
				<div className="flex flex-col items-center gap-3 text-center">
					<SimulatorGlyph />
					<div>
						<h2 className="text-sm font-medium text-foreground">{title}</h2>
						{description === undefined ? null : (
							<p className="mt-1 text-xs leading-5 text-muted-foreground">
								{description}
							</p>
						)}
					</div>
				</div>
				{children}
			</div>
		</div>
	);
}

export function SimulatorError({ children }: { children: ReactNode }) {
	return (
		<p role="alert" className="text-[11px] leading-4 text-destructive">
			{children}
		</p>
	);
}

/** Toolbar icon button with a tooltip, sized to the dock's `size-7` controls. */
export function SimulatorIconAction({
	icon,
	label,
	onClick,
	disabled,
	spinning,
}: {
	icon: IconSvgElement;
	label: string;
	onClick: () => void;
	disabled?: boolean;
	spinning?: boolean;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						aria-label={label}
						disabled={disabled}
						onClick={onClick}
						className={DOCK_ICON_BUTTON_CLASS}
					>
						<HugeiconsIcon
							icon={icon}
							className={cn(
								"size-3.5",
								spinning && "animate-spin motion-reduce:animate-none",
							)}
						/>
					</button>
				}
			/>
			<TooltipPopup>{label}</TooltipPopup>
		</Tooltip>
	);
}

export function openSimulatorSettings() {
	const ui = useUiStore.getState();
	ui.setView("settings");
	ui.setSettingsSection({ kind: "simulator" });
}

/**
 * Requirement remedies through the host. App Store and download fixes finish
 * outside Zuse, so unmet requirements are rechecked when the window regains focus.
 */
export function useRequirementFix(
	actions: ReturnType<typeof useSimulatorActions>,
	requirements: ReadonlyArray<SimulatorRequirement>,
): RequirementFix {
	const { run, pending } = actions;
	const unmet = requirements.some((item) => !item.ok && !item.fix?.running);
	useEffect(() => {
		if (!unmet) return;
		const recheck = () => void run("simulators.refresh", {}, "check");
		window.addEventListener("focus", recheck);
		return () => window.removeEventListener("focus", recheck);
	}, [unmet, run]);
	return {
		run: (id) => void run("simulators.fix", { requirement: id }, `fix:${id}`),
		pending: pending?.startsWith("fix:")
			? (pending.slice(4) as SimulatorRequirement["id"])
			: null,
	};
}
