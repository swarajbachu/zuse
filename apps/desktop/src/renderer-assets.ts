import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const types: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".wasm": "application/wasm",
};

/** Serve packaged renderer modules from a standard origin instead of file://. */
export const serveRendererAsset = async (
	root: string,
	request: Request,
): Promise<Response> => {
	if (request.method !== "GET" && request.method !== "HEAD")
		return new Response(null, { status: 405 });
	try {
		const path = decodeURIComponent(new URL(request.url).pathname);
		if (path.includes("\\") || path.includes("\0"))
			return new Response(null, { status: 400 });
		const base = await realpath(root);
		const file = await realpath(
			resolve(base, `.${path === "/" ? "/index.html" : path}`),
		);
		const local = relative(base, file);
		if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`))
			return new Response(null, { status: 403 });
		return new Response(
			request.method === "HEAD" ? null : await readFile(file),
			{
				headers: {
					"content-type": types[extname(file)] ?? "application/octet-stream",
					"x-content-type-options": "nosniff",
				},
			},
		);
	} catch {
		return new Response(null, { status: 404 });
	}
};
