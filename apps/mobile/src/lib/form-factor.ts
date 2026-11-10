import { createContext, use } from "react";
import { Platform, useWindowDimensions } from "react-native";

import { colors } from "~/theme";

/**
 * Smallest side that counts as a large screen: Android's `sw600dp` tablets,
 * iPads, and an unfolded iPhone Duo.
 */
export const TABLET_MIN_SIDE = 600;

/** Widest comfortable column for reading chats and forms on large screens. */
export const READABLE_WIDTH = 840;

/** Width of the iOS split view's chat sidebar on large screens. */
export const SIDEBAR_WIDTH = 320;

export const isTabletSize = (size: {
	readonly width: number;
	readonly height: number;
}): boolean => Math.min(size.width, size.height) >= TABLET_MIN_SIDE;

/**
 * iOS windows rotate with the device, including the folded Duo outer display.
 * Compact Android screens retain their portrait-first layout.
 */
export const shouldLockPortrait = (screen: {
	readonly width: number;
	readonly height: number;
}): boolean => Platform.OS !== "ios" && !isTabletSize(screen);

/**
 * Width the split view's sidebar currently takes from the content area; 0 when
 * the split is collapsed or the sidebar is hidden.
 */
export const SidebarWidthContext = createContext(0);

/** Window-based, so split-screen and freeform windows get the phone layout. */
export function useIsWideLayout(): boolean {
	const { width } = useWindowDimensions();
	return width >= TABLET_MIN_SIDE;
}

/**
 * Side inset that centers a readable column when the content area is wide; 0
 * on phones and narrow windows.
 */
export function useReadableInset(): number {
	const { width } = useWindowDimensions();
	const contentWidth = width - use(SidebarWidthContext);
	return contentWidth >= TABLET_MIN_SIDE
		? Math.max(0, Math.floor((contentWidth - READABLE_WIDTH) / 2))
		: 0;
}

/** Screen `contentStyle` that keeps content in the readable column. */
export function useReadableContentStyle() {
	const inset = useReadableInset();
	return { backgroundColor: colors.bg, paddingHorizontal: inset };
}
