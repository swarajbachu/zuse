export type ComposerTriggerKind = "slash" | "at";

export interface ComposerTrigger {
	readonly kind: ComposerTriggerKind;
	readonly from: number;
	readonly to: number;
	readonly query: string;
}

const TRIGGER_CHARS: Readonly<Record<string, ComposerTriggerKind>> = {
	"/": "slash",
	"@": "at",
};

/**
 * Detect the trigger at a plain-text cursor position. UI adapters can suppress
 * detection inside their own atomic chips before calling this shared parser.
 */
export const detectComposerTrigger = (
	text: string,
	cursor: number,
): ComposerTrigger | null => {
	const position = Math.max(0, Math.min(cursor, text.length));
	const start = Math.max(0, position - 64);
	const slice = text.slice(start, position);

	for (let index = slice.length - 1; index >= 0; index -= 1) {
		const char = slice[index] ?? "";
		if (/\s/u.test(char)) return null;
		const kind = TRIGGER_CHARS[char];
		if (kind === undefined) continue;
		const from = start + index;
		const before = from === 0 ? "" : text.slice(from - 1, from);
		if (from !== 0 && !/\s/u.test(before)) continue;
		return {
			kind,
			from,
			to: position,
			query: slice.slice(index + 1),
		};
	}
	return null;
};

export const replaceComposerTrigger = (
	text: string,
	trigger: ComposerTrigger,
	replacement: string,
): { readonly text: string; readonly cursor: number } => {
	const next = `${text.slice(0, trigger.from)}${replacement}${text.slice(trigger.to)}`;
	return {
		text: next,
		cursor: trigger.from + replacement.length,
	};
};

/** True only when a selected reference token still exists as a whole token. */
export const containsComposerToken = (text: string, token: string): boolean => {
	let from = 0;
	while (from <= text.length - token.length) {
		const index = text.indexOf(token, from);
		if (index < 0) return false;
		const before = index === 0 ? "" : (text[index - 1] ?? "");
		const after = text[index + token.length] ?? "";
		if (
			(index === 0 || /\s/u.test(before)) &&
			(after.length === 0 || /\s/u.test(after))
		) {
			return true;
		}
		from = index + token.length;
	}
	return false;
};

/**
 * Drops references whose typed token was removed without allocating when the
 * reference set is unchanged. Composer adapters call this on every keystroke,
 * so stable identity prevents unrelated composer chrome from re-rendering.
 */
export const retainComposerReferences = <Reference>(
	references: Reference[],
	text: string,
	tokenFor: (reference: Reference) => string,
): Reference[] => {
	let next: Reference[] | null = null;
	for (let index = 0; index < references.length; index += 1) {
		const reference = references[index];
		if (reference === undefined) continue;
		if (containsComposerToken(text, tokenFor(reference))) {
			next?.push(reference);
			continue;
		}
		if (next === null) next = references.slice(0, index);
	}
	return next ?? references;
};
