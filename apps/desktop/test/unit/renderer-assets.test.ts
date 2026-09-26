import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import Path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
	createRendererAssetHandler,
	PACKAGED_RENDERER_URL,
	rendererAssetContentType,
	resolveRendererAsset,
} from "../../src/renderer-assets.ts";

const rendererRoot = Path.resolve("/tmp/zuse-renderer-dist");

describe("packaged renderer assets", () => {
	it("resolves query-bearing assets inside the renderer root", () => {
		expect(
			resolveRendererAsset(
				rendererRoot,
				"zuse://renderer/assets/main-abc.js?cache=1#ignored",
			),
		).toEqual({
			kind: "asset",
			absolutePath: Path.join(rendererRoot, "assets", "main-abc.js"),
			cacheControl: "public, max-age=31536000, immutable",
			contentType: "text/javascript; charset=utf-8",
		});
		expect(resolveRendererAsset(rendererRoot, PACKAGED_RENDERER_URL)).toEqual({
			kind: "asset",
			absolutePath: Path.join(rendererRoot, "index.html"),
			cacheControl: "no-cache",
			contentType: "text/html; charset=utf-8",
		});
	});

	it("rejects encoded traversal, Windows drives, malformed escapes, and other hosts", () => {
		expect(
			resolveRendererAsset(rendererRoot, "zuse://renderer/%2e%2e%2foutside.js"),
		).toEqual({ kind: "rejected", status: 403 });
		expect(
			resolveRendererAsset(rendererRoot, "zuse://renderer/%2e%2e%5coutside.js"),
		).toEqual({ kind: "rejected", status: 403 });
		expect(
			resolveRendererAsset(
				rendererRoot,
				"zuse://renderer/C:%5cWindows%5csystem.ini",
			),
		).toEqual({ kind: "rejected", status: 403 });
		expect(resolveRendererAsset(rendererRoot, "zuse://renderer/%zz")).toEqual({
			kind: "rejected",
			status: 400,
		});
		expect(
			resolveRendererAsset(rendererRoot, "zuse://attachments/main.js"),
		).toEqual({ kind: "rejected", status: 404 });
	});

	it("serves exact module MIME types and turns missing files into 404s", async () => {
		const fetchFile = vi
			.fn<(absolutePath: string, request: Request) => Promise<Response>>()
			.mockImplementation(async (absolutePath) => {
				if (absolutePath.endsWith("missing.js")) {
					throw new Error("ENOENT");
				}
				return new Response("asset bytes");
			});
		const handle = createRendererAssetHandler({
			rendererRoot,
			fetchFile,
			realpath: async (path) => path,
		});

		const wasm = await handle(
			new Request("zuse://renderer/assets/ghostty.wasm"),
		);
		expect(wasm.status).toBe(200);
		expect(wasm.headers.get("content-type")).toBe("application/wasm");
		expect(wasm.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await wasm.text()).toBe("asset bytes");

		const missing = await handle(
			new Request("zuse://renderer/assets/missing.js"),
		);
		expect(missing.status).toBe(404);
	});

	it("serves HEAD without a body and rejects unsupported methods", async () => {
		const fetchFile = vi
			.fn<(absolutePath: string, request: Request) => Promise<Response>>()
			.mockResolvedValue(new Response("module bytes"));
		const handle = createRendererAssetHandler({
			rendererRoot,
			fetchFile,
			realpath: async (path) => path,
		});

		const head = await handle(
			new Request("zuse://renderer/assets/main.js", { method: "HEAD" }),
		);
		expect(head.status).toBe(200);
		expect(head.body).toBeNull();
		expect(head.headers.get("content-type")).toBe(
			"text/javascript; charset=utf-8",
		);

		const post = await handle(
			new Request("zuse://renderer/assets/main.js", { method: "POST" }),
		);
		expect(post.status).toBe(405);
		expect(post.headers.get("allow")).toBe("GET, HEAD");
		expect(fetchFile).toHaveBeenCalledTimes(1);
	});

	it("maps renderer formats to deterministic MIME types", () => {
		expect(rendererAssetContentType("index.html")).toBe(
			"text/html; charset=utf-8",
		);
		expect(rendererAssetContentType("chunk.js")).toBe(
			"text/javascript; charset=utf-8",
		);
		expect(rendererAssetContentType("font.woff2")).toBe("font/woff2");
		expect(rendererAssetContentType("terminal.wasm")).toBe("application/wasm");
		expect(rendererAssetContentType("unknown.bin")).toBe(
			"application/octet-stream",
		);
	});
});

it("retains real filesystem containment when serving packaged modules", async () => {
	const root = await mkdtemp(Path.join(tmpdir(), "renderer-assets-"));
	const outside = await mkdtemp(Path.join(tmpdir(), "renderer-outside-"));
	try {
		await writeFile(Path.join(root, "entry.js"), "export default 1;");
		await writeFile(Path.join(outside, "private.js"), "private");
		await symlink(
			Path.join(outside, "private.js"),
			Path.join(root, "escape.js"),
		);
		const handle = createRendererAssetHandler({
			rendererRoot: root,
			fetchFile: async (path) => new Response(await readFile(path)),
		});
		const module = await handle(new Request("zuse://renderer/entry.js"));
		expect(module.headers.get("content-type")).toBe(
			"text/javascript; charset=utf-8",
		);
		expect(await module.text()).toBe("export default 1;");
		expect(
			(await handle(new Request("zuse://renderer/escape.js"))).status,
		).toBe(403);
		expect(
			(await handle(new Request("zuse://renderer/missing.js"))).status,
		).toBe(404);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});
