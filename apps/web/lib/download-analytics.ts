// A redirect proves an installer was offered, not that its transfer completed.
export function downloadAnalyticsIdentity(
	request: Request,
	key: string,
): string | null {
	if (
		!key ||
		request.headers.get("dnt") === "1" ||
		request.headers.get("sec-gpc") === "1" ||
		request.headers.get("next-router-prefetch") === "1" ||
		/prefetch/i.test(
			request.headers.get("purpose") ??
				request.headers.get("sec-purpose") ??
				"",
		)
	)
		return null;
	const name = `ph_${key}_posthog`;
	const cookie = (request.headers.get("cookie") ?? "")
		.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${name}=`));
	if (!cookie) return null;
	try {
		const value = JSON.parse(decodeURIComponent(cookie.slice(name.length + 1)));
		return typeof value.distinct_id === "string" &&
			/^[a-zA-Z0-9_-]{16,128}$/.test(value.distinct_id)
			? value.distinct_id
			: null;
	} catch {
		return null;
	}
}
export async function captureDownloadResolution({
	request,
	key,
	host,
	target,
	outcome,
}: {
	request: Request;
	key: string;
	host: string;
	target: string;
	outcome: "installer" | "releases_fallback";
}): Promise<void> {
	const distinctId = downloadAnalyticsIdentity(request, key);
	if (!distinctId) return;
	try {
		await fetch(`${host.replace(/\/$/, "")}/capture/`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				api_key: key,
				event: "website_download_resolved",
				timestamp: new Date().toISOString(),
				properties: {
					distinct_id: distinctId,
					$insert_id: crypto.randomUUID(),
					$process_person_profile: false,
					surface: "website",
					analytics_schema_version: 2,
					download_target: target,
					download_outcome: outcome,
				},
			}),
			signal: AbortSignal.timeout(2_000),
		});
	} catch {
		// Analytics delivery cannot change the download response.
	}
}
