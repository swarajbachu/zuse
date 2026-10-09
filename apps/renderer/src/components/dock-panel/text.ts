/**
 * Type and control roles shared by the right-dock PR and Changes panels.
 * Panels compose these instead of picking raw sizes so both read as one system.
 */
export const DOCK_TITLE_CLASS =
	"text-sm font-semibold leading-snug text-foreground";
export const DOCK_BODY_CLASS = "text-xs leading-5";
export const DOCK_META_CLASS = "text-[11px] text-muted-foreground";
/** Section/label text for headers and the left column of meta rows. */
export const DOCK_LABEL_CLASS = "text-xs font-medium text-muted-foreground";
/** Full-width hover row that bleeds into the section padding. */
export const DOCK_ROW_CLASS =
	"-mx-2 flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50";
export const DOCK_ICON_BUTTON_CLASS =
	"inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40";
/** Actions that should only compete for attention on the hovered row. */
export const DOCK_HOVER_REVEAL_CLASS =
	"opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100";
