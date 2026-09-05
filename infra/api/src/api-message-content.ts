import type { ApiAsset } from "@zuse/contracts";

const PREFIX = "zuse-api-message-v1:";

export interface ApiMessageContent {
	readonly text: string;
	readonly attachments: ReadonlyArray<ApiAsset>;
}

/**
 * Keep the sealed ledger column backwards compatible with its original plain
 * text format. Rich user messages use an explicit prefix so arbitrary JSON in
 * a prompt can never be mistaken for an envelope.
 */
export const encodeApiMessageContent = (content: ApiMessageContent): string =>
	`${PREFIX}${JSON.stringify({
		text: content.text,
		attachments: content.attachments,
	})}`;

export const decodeApiMessageContent = (
	sealedPlaintext: string,
): ApiMessageContent => {
	if (!sealedPlaintext.startsWith(PREFIX))
		return { text: sealedPlaintext, attachments: [] };
	try {
		const decoded = JSON.parse(sealedPlaintext.slice(PREFIX.length)) as {
			readonly text?: unknown;
			readonly attachments?: unknown;
		};
		if (
			typeof decoded.text !== "string" ||
			!Array.isArray(decoded.attachments) ||
			!decoded.attachments.every(
				(value) =>
					typeof value === "object" &&
					value !== null &&
					typeof (value as { readonly assetId?: unknown }).assetId ===
						"string" &&
					typeof (value as { readonly mimeType?: unknown }).mimeType ===
						"string" &&
					typeof (value as { readonly originalName?: unknown }).originalName ===
						"string" &&
					typeof (value as { readonly sizeBytes?: unknown }).sizeBytes ===
						"number",
			)
		)
			throw new Error("invalid API message envelope");
		return {
			text: decoded.text,
			attachments: decoded.attachments as ReadonlyArray<ApiAsset>,
		};
	} catch {
		// This indicates corrupted authenticated content. Returning the literal
		// value is safer than dropping a command during rollout.
		return { text: sealedPlaintext, attachments: [] };
	}
};
