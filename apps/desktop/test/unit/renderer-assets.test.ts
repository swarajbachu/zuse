import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { serveRendererAsset } from "../../src/renderer-assets.ts";

it("serves modules with their MIME type and rejects escaping symlinks", async () => {
	const root = await mkdtemp(join(tmpdir(), "renderer-assets-"));
	const outside = await mkdtemp(join(tmpdir(), "renderer-outside-"));
	try {
		await writeFile(join(root, "entry.js"), "export default 1;");
		await writeFile(join(outside, "private.js"), "private");
		await symlink(join(outside, "private.js"), join(root, "escape.js"));
		const module = await serveRendererAsset(
			root,
			new Request("zuse://app/entry.js"),
		);
		expect(module.headers.get("content-type")).toBe(
			"text/javascript; charset=utf-8",
		);
		expect(await module.text()).toBe("export default 1;");
		expect(
			(await serveRendererAsset(root, new Request("zuse://app/escape.js")))
				.status,
		).toBe(403);
		expect(
			(await serveRendererAsset(root, new Request("zuse://app/missing.js")))
				.status,
		).toBe(404);
		expect(
			(
				await serveRendererAsset(
					root,
					new Request("zuse://app/entry.js", { method: "POST" }),
				)
			).status,
		).toBe(405);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});
