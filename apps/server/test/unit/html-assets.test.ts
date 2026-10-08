import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { embedHtmlImages } from "../../src/html-render/assets.ts";

it("embeds workspace images across HTML, CSS and JS, preserving remote assets", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "zuse-html-assets-"));
	try {
		const path = join(cwd, "test.png");
		await writeFile(path, Buffer.from("89504e470d0a1a0a", "hex"));
		const html = `<img src="${path}"><style>a{background:url(${path})}</style><script>const image='${path}'</script><img src="https://example.com/image.png">`;
		const result = await embedHtmlImages(
			html,
			cwd,
			new AbortController().signal,
		);
		expect(result.match(/data:image\/png;base64/g)).toHaveLength(3);
		expect(result).toContain("https://example.com/image.png");
		await symlink("/etc/passwd", join(cwd, "escape.png"));
		await expect(
			embedHtmlImages(
				`<img src="${cwd}/escape.png">`,
				cwd,
				new AbortController().signal,
			),
		).rejects.toThrow("escapes workspace");
		await expect(
			embedHtmlImages('<img src="/etc/nope.png">', cwd, AbortSignal.abort()),
		).rejects.toThrow();
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

it("bounds expanded bytes including repeated uses of the same image", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "zuse-html-size-"));
	try {
		const path = join(cwd, "large.png");
		await writeFile(
			path,
			Buffer.concat([
				Buffer.from("89504e470d0a1a0a", "hex"),
				Buffer.alloc(1_000_000),
			]),
		);
		await expect(
			embedHtmlImages(
				`<img src="${path}">`.repeat(4),
				cwd,
				new AbortController().signal,
			),
		).rejects.toThrow("exceeds 4 MB");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
