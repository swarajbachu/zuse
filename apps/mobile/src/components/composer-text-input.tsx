import {
	type ComposerTrigger,
	detectComposerTrigger,
} from "@zuse/client-runtime/composer-trigger";
import {
	type MutableRefObject,
	type Ref,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import {
	type NativeSyntheticEvent,
	TextInput,
	type TextInputSelectionChangeEventData,
} from "react-native";

import { colors } from "~/theme";

export type ComposerTextInputHandle = {
	getText: () => string;
	clear: () => void;
	replaceRange: (from: number, to: number, replacement: string) => void;
	insertAtCursor: (text: string) => void;
	replaceAll: (text: string) => void;
};

/**
 * Owns the composer's text state so keystrokes re-render only this small
 * component — not the surrounding glass surface, menus, and pills. The parent
 * observes only the empty↔non-empty boundary via `onHasTextChange` and reads
 * the full text imperatively on submit.
 */
export function ComposerTextInput({
	ref,
	initialText,
	placeholder,
	autoFocusOnMountRef,
	onHasTextChange,
	onFocus,
	onBlur,
	onPersist,
	onTextChange,
	onTriggerChange,
}: {
	ref: Ref<ComposerTextInputHandle>;
	initialText: string;
	placeholder: string;
	/** Focus on mount only when the user tapped the collapsed pill. */
	autoFocusOnMountRef: MutableRefObject<boolean>;
	onHasTextChange: (hasText: boolean) => void;
	onFocus: () => void;
	onBlur: () => void;
	/** Called with the current text on blur and unmount (draft persistence). */
	onPersist: (text: string) => void;
	onTextChange?: (text: string) => void;
	onTriggerChange?: (trigger: ComposerTrigger | null) => void;
}) {
	const [text, setText] = useState(initialText);
	const textRef = useRef(initialText);
	const hadTextRef = useRef(initialText.trim().length > 0);
	const onPersistRef = useRef(onPersist);
	const selectionRef = useRef({
		start: initialText.length,
		end: initialText.length,
	});
	useEffect(() => {
		onPersistRef.current = onPersist;
	});
	// Persist the draft when this input unmounts (thread switch, collapse).
	useEffect(
		() => () => {
			onPersistRef.current(textRef.current);
		},
		[],
	);

	useImperativeHandle(ref, () => ({
		getText: () => textRef.current,
		clear: () => {
			textRef.current = "";
			hadTextRef.current = false;
			setText("");
			onTextChange?.("");
			onTriggerChange?.(null);
		},
		replaceRange: (from, to, replacement) => {
			const next = `${textRef.current.slice(0, from)}${replacement}${textRef.current.slice(to)}`;
			textRef.current = next;
			selectionRef.current = {
				start: from + replacement.length,
				end: from + replacement.length,
			};
			setText(next);
			onTextChange?.(next);
			onTriggerChange?.(null);
		},
		insertAtCursor: (inserted) => {
			const { start, end } = selectionRef.current;
			const needsSpace =
				start > 0 &&
				textRef.current[start - 1] !== " " &&
				textRef.current[start - 1] !== "\n";
			const replacement = `${needsSpace ? " " : ""}${inserted}`;
			const next = `${textRef.current.slice(0, start)}${replacement}${textRef.current.slice(end)}`;
			const cursor = start + replacement.length;
			textRef.current = next;
			selectionRef.current = { start: cursor, end: cursor };
			setText(next);
			onTextChange?.(next);
			onTriggerChange?.(null);
			const hasText = next.trim().length > 0;
			if (hasText !== hadTextRef.current) {
				hadTextRef.current = hasText;
				onHasTextChange(hasText);
			}
		},
		replaceAll: (next) => {
			textRef.current = next;
			selectionRef.current = { start: next.length, end: next.length };
			setText(next);
			onTextChange?.(next);
			onTriggerChange?.(null);
			const hasText = next.trim().length > 0;
			hadTextRef.current = hasText;
			onHasTextChange(hasText);
		},
	}));

	const handleChange = (next: string) => {
		textRef.current = next;
		setText(next);
		onTextChange?.(next);
		onTriggerChange?.(
			detectComposerTrigger(
				next,
				Math.min(selectionRef.current.start, next.length),
			),
		);
		const hasText = next.trim().length > 0;
		if (hasText !== hadTextRef.current) {
			hadTextRef.current = hasText;
			onHasTextChange(hasText);
		}
	};

	const handleSelection = (
		event: NativeSyntheticEvent<TextInputSelectionChangeEventData>,
	) => {
		selectionRef.current = event.nativeEvent.selection;
		onTriggerChange?.(
			detectComposerTrigger(textRef.current, event.nativeEvent.selection.start),
		);
	};

	return (
		<TextInput
			// Focus on mount only when the user opened the bar by tapping the
			// collapsed pill — avoids popping the keyboard on auto-expand.
			ref={(node) => {
				if (node && autoFocusOnMountRef.current) {
					autoFocusOnMountRef.current = false;
					node.focus();
				}
			}}
			className="max-h-36 min-h-11 px-1 py-2 font-sans text-[17px] leading-6 text-foreground"
			multiline
			placeholder={placeholder}
			placeholderTextColor={colors.tertiaryFg}
			value={text}
			onChangeText={handleChange}
			selection={selectionRef.current}
			onSelectionChange={handleSelection}
			onFocus={onFocus}
			onBlur={() => {
				onPersist(textRef.current);
				onBlur();
			}}
		/>
	);
}
