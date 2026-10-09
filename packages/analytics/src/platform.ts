export function normalizeAnalyticsOs(platform: string): string {
	switch (platform) {
		case "darwin":
		case "macos":
			return "macos";
		case "win32":
		case "windows":
			return "windows";
		case "linux":
			return "linux";
		default:
			return "unknown";
	}
}
