import { after, NextResponse } from "next/server";

import { resolveDownloadTarget, selectReleaseAsset } from "@/lib/download";
import { captureDownloadResolution } from "@/lib/download-analytics";
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

	const finish = (
		destination: string,
		outcome: "installer" | "releases_fallback",
	) => {
		if (process.env.NODE_ENV === "production")
			after(() =>
				captureDownloadResolution({
					request,
					key: process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim() ?? "",
					host:
						process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
					target: target ?? "unsupported",
					outcome,
				}),
			);
		return redirect(destination);
	};
	if (target === null) return finish(FALLBACK_URL, "releases_fallback");

	try {
		const response = await fetch(RELEASE_API_URL, {
			headers: {
				Accept: "application/vnd.github+json",
			},
			next: { revalidate: 300 },
		});

		if (!response.ok) {
			return finish(FALLBACK_URL, "releases_fallback");
		}

		const release = (await response.json()) as GitHubRelease;
		const assets = Array.isArray(release.assets) ? release.assets : [];
		const installer = selectReleaseAsset(assets, target);

		if (installer !== null) {
			return finish(installer.browser_download_url, "installer");
		}
	} catch {
		// Fall through to the public releases page.
	}

	return finish(FALLBACK_URL, "releases_fallback");
}
