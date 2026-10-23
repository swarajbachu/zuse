import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { GeneratedImageCard } from "../../src/components/generated-image-card.tsx";
import { ToolRow } from "../../src/components/tool-row.tsx";

it("shows the inner command of a login-shell wrapper", () => {
	const html = renderToStaticMarkup(
		<ToolRow
			tool="Bash"
			input={{ command: `/bin/zsh -lc "cp a.png out/b.png"` }}
		/>,
	);
	expect(html).toContain("cp a.png out/b.png");
	expect(html).not.toContain("/bin/zsh");
});

it("renders a pending image generation as a labelled row", () => {
	const html = renderToStaticMarkup(
		<ToolRow tool="GenerateImage" input={{}} />,
	);
	expect(html).toContain("Generating image");
});

const PNG_1536x1024 = "iVBORw0KGgoAAAANSUhEUgAABgAAAAQACAYAAAAncZJC";

const imageOutput = (extra: Record<string, unknown> = {}) => ({
	isError: false,
	output: {
		...extra,
		content: [{ type: "image", data: PNG_1536x1024, mimeType: "image/png" }],
	},
});

it("renders a generated image with its size, status, and prompt", () => {
	const html = renderToStaticMarkup(
		<GeneratedImageCard
			startedAt={new Date()}
			result={imageOutput({ prompt: "A terracotta app icon" })}
		/>,
	);
	expect(html).toContain(`src="data:image/png;base64,${PNG_1536x1024}"`);
	expect(html).toContain("aspect-ratio:1536 / 1024");
	expect(html).toContain("1536 × 1024");
	expect(html).toContain("Generated image");
	expect(html).toContain("“A terracotta app icon”");
	expect(html).not.toContain('aria-busy="true"');
});

it("holds a square frame with a live timer while generating", () => {
	const html = renderToStaticMarkup(
		<GeneratedImageCard
			result={undefined}
			startedAt={new Date(Date.now() - 14_000)}
		/>,
	);
	expect(html).toContain('aria-busy="true"');
	expect(html).toContain("aspect-ratio:1 / 1");
	expect(html).toContain("<canvas");
	expect(html).toContain("Generating image");
	expect(html).toContain("0:14");
});

it("does not replay the reveal for images loaded from history", () => {
	const html = renderToStaticMarkup(
		<GeneratedImageCard startedAt={new Date()} result={imageOutput()} />,
	);
	expect(html).not.toContain("blur(3px)");
	expect(html).not.toContain("<canvas");
});

it("shows a failed status without an empty frame", () => {
	const html = renderToStaticMarkup(
		<GeneratedImageCard
			startedAt={new Date()}
			result={{ isError: true, output: "Image generation failed." }}
		/>,
	);
	expect(html).not.toContain("<img");
	expect(html).not.toContain('role="img"');
	expect(html).toContain("Image generation failed");
});

it("offers the image viewer even without a filesystem path", () => {
	const html = renderToStaticMarkup(
		<GeneratedImageCard startedAt={new Date()} result={imageOutput()} />,
	);
	expect(html).toContain('aria-label="Open image"');
});
