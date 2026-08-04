export type DownloadTarget = "macos" | "linux-appimage" | "linux-deb";

export type ReleaseAsset = {
	name: string;
	browser_download_url: string;
};

const isMobileUserAgent = (userAgent: string) =>
	/android|iphone|ipad|ipod|mobile/i.test(userAgent);

export const resolveDownloadTarget = ({
	platform,
	format,
	userAgent,
}: {
	platform: string | null;
	format: string | null;
	userAgent: string | null;
}): DownloadTarget | null => {
	const requestedPlatform = platform?.toLowerCase();
	const requestedFormat = format?.toLowerCase();

	if (["mac", "macos", "darwin"].includes(requestedPlatform ?? "")) {
		return "macos";
	}

	if (requestedPlatform === "linux") {
		return requestedFormat === "deb" ? "linux-deb" : "linux-appimage";
	}

	if (isMobileUserAgent(userAgent ?? "")) return null;
	if (/linux|x11/i.test(userAgent ?? "")) return "linux-appimage";
	if (/macintosh|mac os x/i.test(userAgent ?? "")) return "macos";

	return null;
};

const extensionForTarget: Record<DownloadTarget, string> = {
	macos: ".dmg",
	"linux-appimage": ".appimage",
	"linux-deb": ".deb",
};

export const selectReleaseAsset = (
	assets: unknown[],
	target: DownloadTarget,
): ReleaseAsset | null => {
	const extension = extensionForTarget[target];

	for (const asset of assets) {
		if (asset === null || typeof asset !== "object") continue;

		const { name, browser_download_url } = asset as {
			name?: unknown;
			browser_download_url?: unknown;
		};

		if (
			typeof name === "string" &&
			typeof browser_download_url === "string" &&
			name.toLowerCase().endsWith(extension)
		) {
			return { name, browser_download_url };
		}
	}

	return null;
};
