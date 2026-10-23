import "@zuse/i18n/english/projects";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { Master } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import {
	Add01Icon,
	Clock01Icon,
	File01Icon,
	HelpCircleIcon,
	MoreHorizontalIcon,
	PanelRightCloseIcon,
	PanelRightOpenIcon,
	PauseIcon,
	PlayIcon,
	StopCircleIcon,
} from "@zuse/icons/solid-rounded";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import { useZotOnboardingStore } from "../../store/zot-onboarding.ts";
import {
	ShowProjectsPanelButton,
	TOP_BAR_ICON_BUTTON_CLASS,
	TOP_BAR_NATIVE_CONTROLS_INSET_CLASS,
	TOP_BAR_SECTION_CLASS,
	useTopBarLeadingPad,
} from "../top-bar.tsx";
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuSeparator,
	MenuTrigger,
} from "../ui/menu.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip.tsx";
import { avatarFor, Mascot } from "./mascot.tsx";

/** The `h-9` main-pane bar for Master screens; mirrors `TopBarMain`. */
function MasterTopBar({
	label,
	children,
}: {
	readonly label: string;
	readonly children: ReactNode;
}) {
	const leftPad = useTopBarLeadingPad();
	return (
		<div
			role="toolbar"
			aria-label={label}
			className={`${TOP_BAR_SECTION_CLASS} ${leftPad} ${TOP_BAR_NATIVE_CONTROLS_INSET_CLASS} border-b border-border/50 bg-muted/20`}
		>
			<ShowProjectsPanelButton />
			{children}
		</div>
	);
}

function BarIconButton({
	label,
	icon,
	disabled,
	pressed,
	onClick,
}: {
	readonly label: string;
	readonly icon: IconSvgElement;
	readonly disabled?: boolean;
	readonly pressed?: boolean;
	readonly onClick: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						aria-label={label}
						aria-pressed={pressed}
						disabled={disabled}
						onClick={onClick}
						className={cn(
							TOP_BAR_ICON_BUTTON_CLASS,
							"disabled:pointer-events-none disabled:opacity-50",
							pressed && "bg-foreground/5 text-foreground",
						)}
					>
						<HugeiconsIcon icon={icon} className="size-3.5" />
					</button>
				}
			/>
			<TooltipPopup>{label}</TooltipPopup>
		</Tooltip>
	);
}

export function MasterHeader({
	master,
	railOpen,
	onToggleRail,
	busy,
	onControl,
	onRenew,
	onOpenHistory,
	onOpenArtifacts,
}: {
	readonly master: Master;
	readonly railOpen: boolean;
	readonly onToggleRail: () => void;
	readonly busy: boolean;
	readonly onControl: (status: "active" | "paused" | "stopped") => void;
	readonly onRenew: () => void;
	readonly onOpenHistory: () => void;
	readonly onOpenArtifacts: () => void;
}) {
	const { message } = useMessages("projects");
	const moving = master.status === "moving";
	const running = master.status === "active";
	return (
		<MasterTopBar label={master.settings.name}>
			<div className="flex min-w-0 flex-1 items-center gap-2 px-1">
				<span
					data-zot-guide="identity"
					className="flex h-7 min-w-0 items-center gap-2 px-1.5"
				>
					<Mascot
						avatar={avatarFor(master)}
						seed={master.id}
						state={running ? "idle" : "paused"}
					/>
					<h1 className="min-w-0 truncate text-[12px] font-medium text-foreground">
						{master.settings.name}
					</h1>
				</span>
				{running ? null : (
					<span className="shrink-0 text-muted-foreground">
						{message(`projects:masters_status_${master.status}`)}
					</span>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-0.5">
				<BarIconButton
					label={
						running
							? message("projects:masters_pause")
							: message("projects:masters_resume")
					}
					icon={running ? PauseIcon : PlayIcon}
					disabled={busy || moving}
					onClick={() => onControl(running ? "paused" : "active")}
				/>
				<BarIconButton
					label={
						railOpen
							? message("projects:masters_hide_details")
							: message("projects:masters_show_details")
					}
					icon={railOpen ? PanelRightCloseIcon : PanelRightOpenIcon}
					pressed={railOpen}
					onClick={onToggleRail}
				/>
				<Menu>
					<MenuTrigger
						data-zot-guide="continuity"
						aria-label={message("projects:masters_more_actions")}
						className={cn(
							TOP_BAR_ICON_BUTTON_CLASS,
							"data-[popup-open]:bg-foreground/5 data-[popup-open]:text-foreground",
						)}
					>
						<HugeiconsIcon icon={MoreHorizontalIcon} className="size-3.5" />
					</MenuTrigger>
					<MenuPopup align="end" className="min-w-52">
						<MenuItem disabled={busy} onClick={onRenew}>
							<HugeiconsIcon icon={Add01Icon} />
							{message("projects:masters_fresh_chat")}
						</MenuItem>
						<MenuItem onClick={onOpenHistory}>
							<HugeiconsIcon icon={Clock01Icon} />
							{message("projects:masters_previous_conversations")}
						</MenuItem>
						<MenuItem
							disabled={master.artifacts.length === 0}
							onClick={onOpenArtifacts}
						>
							<HugeiconsIcon icon={File01Icon} />
							{message("projects:masters_artifacts")}
						</MenuItem>
						<MenuItem onClick={useZotOnboardingStore.getState().start}>
							<HugeiconsIcon icon={HelpCircleIcon} />
							{message("projects:masters_guide_open")}
						</MenuItem>
						<MenuSeparator />
						<MenuItem
							variant="destructive"
							disabled={moving || master.status === "stopped"}
							onClick={() => onControl("stopped")}
						>
							<HugeiconsIcon icon={StopCircleIcon} />
							{message("projects:masters_stop_all")}
						</MenuItem>
					</MenuPopup>
				</Menu>
			</div>
		</MasterTopBar>
	);
}
