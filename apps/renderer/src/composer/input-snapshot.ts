import type { ComposerInput } from "@zuse/contracts";

import { attachmentUrl } from "../lib/platform-capabilities.ts";
import type { ComposerDraftSnapshot } from "../store/composer-drafts.ts";

/**
 * Rebuild the canonical CodeMirror document and chip ranges for a durable
 * composer input. Queue editing uses this to move a message back into the
 * regular composer without losing attachments or references.
 */
export const composerSnapshotFromInput = (
	input: ComposerInput,
): ComposerDraftSnapshot => {
	let doc = input.text;
	const chips: ComposerDraftSnapshot["chips"][number][] = [];

	const addToken = (
		token: string,
		meta: ComposerDraftSnapshot["chips"][number]["meta"],
	): void => {
		let from = doc.indexOf(token);
		const overlaps = (start: number, end: number): boolean =>
			chips.some((chip) => start < chip.to && end > chip.from);
		while (from >= 0 && overlaps(from, from + token.length)) {
			from = doc.indexOf(token, from + token.length);
		}
		if (from < 0) {
			const separator = doc.length === 0 || /\s$/.test(doc) ? "" : " ";
			from = doc.length + separator.length;
			doc += `${separator}${token}`;
		}
		chips.push({ from, to: from + token.length, meta });
	};

	for (const ref of input.fileRefs) {
		addToken(`@${ref.relPath}`, {
			kind: "file",
			relPath: ref.relPath,
			absPath: ref.absPath,
			entryKind: ref.kind,
		});
	}
	for (const ref of input.skillRefs) {
		const token = `$${ref.name}`;
		const legacyToken = `/${ref.name}`;
		if (!doc.includes(token) && doc.includes(legacyToken)) {
			doc = doc.replace(legacyToken, token);
		}
		addToken(token, {
			kind: "skill",
			name: ref.name,
			scope: ref.scope,
		});
	}
	for (const attachment of input.attachments) {
		addToken(`[image:${attachment.id}]`, {
			kind: "image",
			id: attachment.id,
			mimeType: attachment.mimeType,
			originalName: attachment.originalName,
			previewUrl: attachment.mimeType.startsWith("image/")
				? attachmentUrl(attachment.id)
				: "",
		});
	}

	return {
		doc,
		chips: chips.sort((left, right) => left.from - right.from),
	};
};
