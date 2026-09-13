type FaviconFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Shared by the HTTP asset route and Electron's privileged asset protocol. */
export const fetchSiteFavicon = async (
	encodedHostname: string,
	fetchImage: FaviconFetch = fetch,
): Promise<Response> => {
	let hostname: string;
	try {
		hostname = decodeURIComponent(encodedHostname);
	} catch {
		return new Response(null, { status: 400 });
	}
	if (!/^[a-z0-9.-]{1,253}$/iu.test(hostname)) {
		return new Response(null, { status: 400 });
	}

	try {
		const remote = await fetchImage(
			`https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=64`,
			{ signal: AbortSignal.timeout(5_000) },
		);
		const contentType = remote.headers.get("content-type");
		if (!remote.ok || !contentType?.startsWith("image/")) {
			await remote.body?.cancel();
			return new Response(null, { status: 404 });
		}
		// Finish the download here so interrupted bodies also use the UI fallback.
		// Fetch decodes the body; upstream encoding/length/cookie headers must not
		// be forwarded with those decoded bytes.
		const bytes = await remote.arrayBuffer();
		return new Response(bytes, {
			headers: {
				"content-type": contentType,
				"cache-control": "public, max-age=86400",
			},
		});
	} catch {
		return new Response(null, { status: 404 });
	}
};
