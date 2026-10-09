import type { HtmlToolsClient } from "@zuse/agents/drivers/html-tools";
import type { AttachmentServiceShape } from "@zuse/agents/kernel/attachment-service";
import { SessionId } from "@zuse/contracts";
import { prepareHtmlDocument } from "@zuse/utils/html-document";
import { Effect } from "effect";
import { embedHtmlImages } from "./assets.ts";
import { HtmlPreviewBrowser } from "./preview-browser.ts";

export function createHtmlTools(attachments: AttachmentServiceShape) {
	const browser = new HtmlPreviewBrowser();
	const client: HtmlToolsClient = {
		preview: async (_sessionId, cwd, input, signal) =>
			browser.preview(
				{ ...input, html: await embedHtmlImages(input.html, cwd, signal) },
				signal,
			),
		render: async (sessionId, cwd, input, signal) => {
			const html = prepareHtmlDocument(
				await embedHtmlImages(input.html, cwd, signal),
			);
			signal.throwIfAborted();
			const title = input.title.trim();
			const attachment = await Effect.runPromise(
				attachments.upload(
					SessionId.make(sessionId),
					new TextEncoder().encode(html),
					"text/html",
					`${title.replace(/[^a-z0-9 -]/gi, "_")}.html`,
					cwd,
				),
				{ signal },
			);
			return { attachmentId: attachment.id, title, height: input.height };
		},
	};
	return { client, close: () => browser.close() };
}
