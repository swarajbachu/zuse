export type MobileAnalyticsScreen =
	| "chats"
	| "settings"
	| "new chat"
	| "nearby connection"
	| "manual connection"
	| "connection scanner"
	| "connection pairing"
	| "plan viewer"
	| "review"
	| "files"
	| "tool details"
	| "session"
	| "chat threads"
	| "sessions"
	| "other";

const STATIC_SCREENS: Readonly<Record<string, MobileAnalyticsScreen>> = {
	"/": "chats",
	"/settings": "settings",
	"/new-chat": "new chat",
	"/connect/nearby": "nearby connection",
	"/connect/manual": "manual connection",
	"/connect/scan": "connection scanner",
	"/connect/pair": "connection pairing",
	"/plan-viewer": "plan viewer",
};

const connectionScreen = (pathname: string): MobileAnalyticsScreen => {
	if (pathname.includes("/review")) return "review";
	if (pathname.includes("/files") || pathname.includes("/file")) {
		return "files";
	}
	if (pathname.includes("/tool/")) return "tool details";
	if (pathname.includes("/session/")) return "session";
	if (pathname.includes("/chat/")) return "chat threads";
	return "sessions";
};

export const mobileAnalyticsScreen = (
	pathname: string,
): MobileAnalyticsScreen => {
	if (pathname.startsWith("/c/")) return connectionScreen(pathname);
	return STATIC_SCREENS[pathname] ?? "other";
};
