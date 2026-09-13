import type { AndroidSymbol, SFSymbol } from "expo-symbols";

export const materialSymbolNames: Partial<Record<SFSymbol, AndroidSymbol>> = {
	"chevron.left": "chevron_left",
	"chevron.right": "chevron_right",
	"checkmark.circle.fill": "check_circle",
	"cloud.fill": "cloud",
	wifi: "wifi",
	"qrcode.viewfinder": "qr_code_scanner",
	plus: "add",
	desktopcomputer: "desktop_windows",
	"person.crop.circle.fill": "account_circle",
	"key.fill": "key",
	"rectangle.portrait.and.arrow.right": "logout",
	"bell.badge.fill": "notifications_active",
	"archivebox.fill": "archive",
	sparkles: "auto_awesome",
	"internaldrive.fill": "storage",
	"photo.stack.fill": "photo_library",
	"arrow.counterclockwise": "restart_alt",
	"trash.fill": "delete",
};

export function platformSymbolName(ios: SFSymbol) {
	const material = materialSymbolNames[ios] ?? "help";
	return { ios, android: material, web: material };
}
