import { pathToFileURL } from "node:url";

import type { AttachmentRef } from "@zuse/contracts";

const SUPPORTED_IMAGE_MIME = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);

export type AcpPromptContent =
	| { readonly type: "text"; readonly text: string }
	| {
			readonly type: "image";
			readonly data: string;
			readonly mimeType: string;
			readonly uri?: string;
	  };

export interface ResolvedAcpImage {
	readonly bytes: Uint8Array;
	readonly mimeType: string;
	readonly path?: string;
}

export const buildAcpPromptContent = async (
	text: string,
	attachments: ReadonlyArray<AttachmentRef>,
	resolve: (attachment: AttachmentRef) => Promise<ResolvedAcpImage | null>,
): Promise<ReadonlyArray<AcpPromptContent>> => {
	const content: AcpPromptContent[] = [{ type: "text", text }];
	for (const attachment of attachments) {
		if (attachment.id.startsWith("pending-")) continue;
		const resolved = await resolve(attachment);
		if (resolved === null) continue;
		const mimeType =
			resolved.mimeType.toLowerCase() === "image/jpg"
				? "image/jpeg"
				: resolved.mimeType.toLowerCase();
		if (!SUPPORTED_IMAGE_MIME.has(mimeType)) continue;
		content.push({
			type: "image",
			data: Buffer.from(resolved.bytes).toString("base64"),
			mimeType,
			...(resolved.path === undefined
				? {}
				: { uri: pathToFileURL(resolved.path).href }),
		});
	}
	return content;
};
