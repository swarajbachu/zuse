import { NextResponse } from "next/server";

import { resolveDownloadTarget, selectReleaseAsset } from "@/lib/download";
import { RELEASES_URL } from "@/lib/site";

const RELEASE_API_URL =
	"https://api.github.com/repos/swarajbachu/zuse/releases/latest";

type GitHubRelease = {
	assets?: unknown;
};

const FALLBACK_URL = RELEASES_URL;

const redirect = (url: string) =>
	NextResponse.redirect(url, {
		headers: { Vary: "User-Agent" },
	});

export async function GET(request: Request) {
	const url = new URL(request.url);
	const target = resolveDownloadTarget({
		platform: url.searchParams.get("platform"),
		format: url.searchParams.get("format"),
		userAgent: request.headers.get("user-agent"),
	});

	if (target === null) return redirect(FALLBACK_URL);

	try {
		const response = await fetch(RELEASE_API_URL, {
			headers: {
				Accept: "application/vnd.github+json",
			},
			next: { revalidate: 300 },
		});

		if (!response.ok) {
			return redirect(FALLBACK_URL);
		}

		const release = (await response.json()) as GitHubRelease;
		const assets = Array.isArray(release.assets) ? release.assets : [];
		const installer = selectReleaseAsset(assets, target);

		if (installer !== null) {
			return redirect(installer.browser_download_url);
		}
	} catch {
		// Fall through to the public releases page.
	}

	return redirect(FALLBACK_URL);
}
