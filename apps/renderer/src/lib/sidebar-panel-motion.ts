export interface SidebarVisibilitySnapshot {
	readonly contextKey: string;
	readonly open: boolean;
}

/** Only direct visibility changes inside one sidebar context should animate. */
export function shouldAnimateSidebarVisibility(
	previous: SidebarVisibilitySnapshot | undefined,
	next: SidebarVisibilitySnapshot,
): boolean {
	return (
		previous !== undefined &&
		previous.contextKey === next.contextKey &&
		previous.open !== next.open
	);
}
