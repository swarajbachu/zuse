import { after, NextResponse } from "next/server";

import { resolveDownloadTarget } from "@/lib/download";
import { captureDownloadResolution } from "@/lib/download-analytics";
import { RELEASES_URL } from "@/lib/site";

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

	if (process.env.NODE_ENV === "production")
		after(() =>
			captureDownloadResolution({
				request,
				key: process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim() ?? "",
				host:
					process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
				target: target ?? "unsupported",
				outcome: "releases_page",
			}),
		);

	return redirect(RELEASES_URL);
}
