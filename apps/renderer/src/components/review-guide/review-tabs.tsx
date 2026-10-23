import "@zuse/i18n/english/chat";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { BookOpen, FileCode2, FileText } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export type ReviewMode = "overview" | "guide" | "files";

/**
 * The review's three views, as a floating bar at the bottom of the pane:
 * what the change is, the guided walk through it, and the plain diff.
 */
export function ReviewTabs({
	mode,
	chapterCount,
	fileCount,
	onModeChange,
}: {
	readonly mode: ReviewMode;
	readonly chapterCount: number | null;
	readonly fileCount: number;
	readonly onModeChange: (mode: ReviewMode) => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);
	return (
		<div
			role="tablist"
			aria-label={uiMessage("chat:review_guide_view")}
			className="-translate-x-1/2 pointer-events-auto absolute bottom-5 left-1/2 z-20 flex gap-1 rounded-full bg-card/75 p-1 shadow-[0_0_0_1px_hsl(0_0%_100%/0.07),0_12px_40px_hsl(0_0%_0%/0.45)] backdrop-blur-xl backdrop-saturate-150"
		>
			<Tab
				selected={mode === "overview"}
				onSelect={() => onModeChange("overview")}
				icon={<FileText />}
				label={uiMessage("chat:review_guide_overview")}
			/>
			<Tab
				selected={mode === "guide"}
				onSelect={() => onModeChange("guide")}
				icon={<BookOpen />}
				label={uiMessage("chat:review_guide_title")}
				count={chapterCount}
			/>
			<Tab
				selected={mode === "files"}
				onSelect={() => onModeChange("files")}
				icon={<FileCode2 />}
				label={uiMessage("chat:review_guide_diff_tab")}
				count={fileCount}
			/>
		</div>
	);
}

function Tab({
	selected,
	onSelect,
	icon,
	label,
	count = null,
}: {
	readonly selected: boolean;
	readonly onSelect: () => void;
	readonly icon: ReactNode;
	readonly label: string;
	readonly count?: number | null;
}) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={selected}
			onClick={onSelect}
			className={cn(
				"flex h-9 items-center gap-2 rounded-full px-4 font-medium text-[13px] outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4",
				selected
					? "bg-foreground/[0.08] text-foreground shadow-[inset_0_0_0_1px_hsl(0_0%_100%/0.06)]"
					: "text-muted-foreground hover:text-foreground",
			)}
		>
			{icon}
			{label}
			{count !== null ? (
				<span className="font-normal text-muted-foreground tabular-nums">
					{count}
				</span>
			) : null}
		</button>
	);
}
