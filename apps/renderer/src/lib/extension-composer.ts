import type { ExtensionAttachmentSnapshot } from "@zuse/extension-sdk";

const composers = new Map<
	string,
	(snapshot: ExtensionAttachmentSnapshot) => Promise<void>
>();
export const registerExtensionComposer = (
	sessionId: string,
	attach: (snapshot: ExtensionAttachmentSnapshot) => Promise<void>,
) => {
	composers.set(sessionId, attach);
	return () => {
		if (composers.get(sessionId) === attach) composers.delete(sessionId);
	};
};
export const attachExtensionSnapshot = async (
	sessionId: string | null,
	snapshot: ExtensionAttachmentSnapshot,
) => {
	const attach = sessionId ? composers.get(sessionId) : undefined;
	if (!attach) throw new Error("Open a conversation before attaching context.");
	if (
		!snapshot.text ||
		new TextEncoder().encode(snapshot.text).length > 128 * 1024
	)
		throw new Error("Select less context (maximum 128 KiB per attachment).");
	await attach(structuredClone(snapshot));
};
