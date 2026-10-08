import {
	type HtmlToolsClient,
	handleHtmlTool,
} from "@zuse/agents/drivers/html-tools";
import { expect, it, vi } from "vitest";

it("publishes only after storage succeeds and keeps source out of the result", async () => {
	const render = vi.fn(async () => ({
		attachmentId: "saved",
		title: "Chart",
		height: 100,
	}));
	const client: HtmlToolsClient = { render, preview: vi.fn() };
	const options = { client, sessionId: "session", cwd: "/repo" };
	const result = await handleHtmlTool(
		"html_render",
		{ html: "<h1>Hi</h1>", title: "Chart", height: 100 },
		options,
		new AbortController().signal,
	);
	expect(render).toHaveBeenCalledWith(
		"session",
		"/repo",
		expect.anything(),
		expect.any(AbortSignal),
	);
	expect(JSON.stringify(result)).toContain("saved");
	expect(JSON.stringify(result)).not.toContain("<h1>");
	render.mockRejectedValueOnce(new Error("disk full"));
	await expect(
		handleHtmlTool(
			"html_render",
			{ html: "html", title: "Chart", height: 100 },
			options,
			new AbortController().signal,
		),
	).rejects.toThrow("disk full");
});

it.each([
	{ html: "", title: "Chart", height: 100 },
	{ html: "😀".repeat(130_000), title: "Chart", height: 100 },
	{ html: "html", title: "x".repeat(201), height: 100 },
	{ html: "html", title: " ", height: 100 },
	{ html: "html", title: "Chart", height: 2001 },
	{ html: "html", title: "Chart", height: 79 },
])("rejects invalid input before calling storage", async (input) => {
	const client = { render: vi.fn(), preview: vi.fn() };
	await expect(
		handleHtmlTool(
			"html_render",
			input,
			{ client, sessionId: "s", cwd: "/repo" },
			new AbortController().signal,
		),
	).rejects.toThrow();
	expect(client.render).not.toHaveBeenCalled();
});
