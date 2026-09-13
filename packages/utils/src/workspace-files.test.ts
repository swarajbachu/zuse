import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readWorkspaceText, workspaceFiles } from "./workspace-files.js";

it("respects nested exclusions and bounds reads without following external links", async () => {
	const root = await mkdtemp(join(tmpdir(), "workspace-files-"));
	try {
		await mkdir(join(root, "nested"));
		await mkdir(join(root, "node_modules"));
		await writeFile(join(root, ".gitignore"), "ignored.txt\n");
		await writeFile(join(root, "ignored.txt"), "ignore");
		await writeFile(join(root, "nested/.gitignore"), "local.txt\n");
		await writeFile(join(root, "nested/local.txt"), "ignore");
		await writeFile(join(root, "notes.md"), "notes");
		await writeFile(join(root, "node_modules/package.js"), "ignore");
		await symlink("/etc/passwd", join(root, "outside"));
		const paths = [];
		for await (const path of workspaceFiles(root)) paths.push(path);
		expect(paths).toContain("notes.md");
		expect(paths).not.toContain("ignored.txt");
		expect(paths).not.toContain("nested/local.txt");
		expect(paths).not.toContain("outside");
		expect(paths).not.toContain("node_modules/package.js");
		expect(await readWorkspaceText(root, "notes.md")).toBe("notes");
		await expect(readWorkspaceText(root, "outside")).rejects.toThrow("inside");
		await writeFile(join(root, "large"), Buffer.alloc(1_500_001, 65));
		await expect(readWorkspaceText(root, "large")).rejects.toThrow("limit");
		await writeFile(join(root, "binary"), Buffer.from([65, 0, 66]));
		await expect(readWorkspaceText(root, "binary")).rejects.toThrow("Binary");
		await expect(
			readWorkspaceText(root, "notes.md", AbortSignal.abort()),
		).rejects.toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
