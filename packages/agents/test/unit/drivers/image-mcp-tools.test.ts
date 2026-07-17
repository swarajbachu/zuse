import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { handleImageTool } from "@zuse/agents/drivers/image-mcp-tools";
import { describe, expect, it } from "vitest";

const ONE_PIXEL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

describe("image MCP tools", () => {
	it("returns workspace images as multimodal MCP content", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "zuse-image-tool-"));
		try {
			await mkdir(path.join(cwd, "screenshots"));
			await writeFile(path.join(cwd, "screenshots", "ui.png"), ONE_PIXEL_PNG);
			const result = await handleImageTool(
				"view_image",
				{ path: "screenshots/ui.png" },
				{ cwd },
			);
			expect(result.content[0]).toMatchObject({
				type: "image",
				mimeType: "image/png",
				data: ONE_PIXEL_PNG.toString("base64"),
			});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects unsupported files and symlinks that escape the workspace", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "zuse-image-scope-"));
		const cwd = path.join(root, "workspace");
		const outside = path.join(root, "outside.png");
		try {
			await mkdir(cwd);
			await writeFile(path.join(cwd, "notes.txt"), "not an image");
			await writeFile(outside, ONE_PIXEL_PNG);
			await symlink(outside, path.join(cwd, "escape.png"));
			await expect(
				handleImageTool("view_image", { path: "notes.txt" }, { cwd }),
			).rejects.toThrow(/Unsupported image format/);
			await expect(
				handleImageTool("view_image", { path: "escape.png" }, { cwd }),
			).rejects.toThrow(/escapes workspace/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
