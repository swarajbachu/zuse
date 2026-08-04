import type {
	BrowserWindowConstructorOptions,
	TitleBarOverlay,
} from "electron";

export const WINDOW_TITLE_BAR_HEIGHT = 36;

const DARK_TITLE_BAR = "#0b0b0c";
const LIGHT_TITLE_BAR = "#fafafa";
const DARK_SYMBOLS = "#a1a1aa";
const LIGHT_SYMBOLS = "#52525b";

export type WindowTitleBarOptions = Pick<
	BrowserWindowConstructorOptions,
	"autoHideMenuBar" | "titleBarOverlay" | "titleBarStyle"
>;

export const createTitleBarOverlay = (dark: boolean): TitleBarOverlay => ({
	color: dark ? DARK_TITLE_BAR : LIGHT_TITLE_BAR,
	height: WINDOW_TITLE_BAR_HEIGHT,
	symbolColor: dark ? DARK_SYMBOLS : LIGHT_SYMBOLS,
});

/**
 * Keep one renderer-owned title bar on every desktop OS. macOS supplies its
 * inset traffic lights; Linux and Windows expose their native controls through
 * Chromium's Window Controls Overlay geometry.
 */
export const createWindowTitleBarOptions = (
	platform: NodeJS.Platform,
	dark: boolean,
): WindowTitleBarOptions =>
	platform === "darwin"
		? { autoHideMenuBar: false, titleBarStyle: "hiddenInset" }
		: {
				autoHideMenuBar: true,
				titleBarOverlay: createTitleBarOverlay(dark),
				titleBarStyle: "hidden",
			};
