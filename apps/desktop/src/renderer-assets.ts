import Path from "node:path";

export const RENDERER_ASSET_HOST = "renderer";
export const PACKAGED_RENDERER_URL = `zuse://${RENDERER_ASSET_HOST}/index.html`;

const RENDERER_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
	css: "text/css; charset=utf-8",
	html: "text/html; charset=utf-8",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	js: "text/javascript; charset=utf-8",
	json: "application/json; charset=utf-8",
	map: "application/json; charset=utf-8",
	png: "image/png",
	svg: "image/svg+xml",
	ttf: "font/ttf",
	wasm: "application/wasm",
	webp: "image/webp",
	woff: "font/woff",
	woff2: "font/woff2",
};

export type RendererAssetResolution =
	| {
			readonly kind: "asset";
			readonly absolutePath: string;
			readonly cacheControl: string;
			readonly contentType: string;
	  }
	| {
			readonly kind: "rejected";
			readonly status: 400 | 403 | 404;
	  };

const rejected = (status: 400 | 403 | 404): RendererAssetResolution => ({
	kind: "rejected",
	status,
});

export const rendererAssetContentType = (filename: string): string => {
	const extension = Path.extname(filename).slice(1).toLowerCase();
	return RENDERER_MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
};

/**
 * Resolves one zuse://renderer request without trusting URL path separators.
 * The renderer directory is build-owned, but this origin is externally
 * addressable as a deep-link scheme, so every request still gets a containment
 * check before any file is opened.
 */
export const resolveRendererAsset = (
	rendererRoot: string,
	requestUrl: string,
): RendererAssetResolution => {
	let url: URL;
	try {
		url = new URL(requestUrl);
	} catch {
		return rejected(400);
	}
	if (url.protocol !== "zuse:" || url.host !== RENDERER_ASSET_HOST) {
		return rejected(404);
	}

	let decodedPath: string;
	try {
		decodedPath = decodeURIComponent(url.pathname);
	} catch {
		return rejected(400);
	}
	if (decodedPath.includes("\0")) return rejected(400);

	const segments = decodedPath.replaceAll("\\", "/").split("/");
	if (segments.some((segment) => segment === "..")) return rejected(403);
	// A drive-qualified path becomes absolute under node:path on Windows.
	// Vite-generated asset segments never contain a colon, so reject it before
	// rebuilding the platform-native path to make this policy deterministic.
	if (segments.some((segment) => segment.includes(":"))) return rejected(403);
	const relativePath = segments
		.filter((segment) => segment.length > 0 && segment !== ".")
		.join(Path.sep);
	if (relativePath.length === 0) return rejected(404);

	const normalizedRoot = Path.resolve(rendererRoot);
	const absolutePath = Path.resolve(normalizedRoot, relativePath);
	const relativeToRoot = Path.relative(normalizedRoot, absolutePath);
	if (
		relativeToRoot.length === 0 ||
		relativeToRoot.startsWith(`..${Path.sep}`) ||
		Path.isAbsolute(relativeToRoot)
	) {
		return rejected(403);
	}

	return {
		kind: "asset",
		absolutePath,
		contentType: rendererAssetContentType(absolutePath),
		cacheControl:
			Path.basename(absolutePath) === "index.html" ||
			Path.basename(absolutePath) === "notch.html"
				? "no-cache"
				: "public, max-age=31536000, immutable",
	};
};

type RendererFileFetch = (
	absolutePath: string,
	request: Request,
) => Promise<Response>;

export const createRendererAssetHandler = (options: {
	readonly rendererRoot: string;
	readonly fetchFile: RendererFileFetch;
}): ((request: Request) => Promise<Response>) => {
	return async (request) => {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response(null, {
				status: 405,
				headers: { allow: "GET, HEAD" },
			});
		}
		const resolution = resolveRendererAsset(options.rendererRoot, request.url);
		if (resolution.kind === "rejected") {
			return new Response(null, { status: resolution.status });
		}

		try {
			const file = await options.fetchFile(resolution.absolutePath, request);
			if (!file.ok) return new Response(null, { status: 404 });
			const headers = new Headers(file.headers);
			headers.set("cache-control", resolution.cacheControl);
			headers.set("content-type", resolution.contentType);
			headers.set("x-content-type-options", "nosniff");
			return new Response(request.method === "HEAD" ? null : file.body, {
				status: file.status,
				headers,
			});
		} catch {
			return new Response(null, { status: 404 });
		}
	};
};
