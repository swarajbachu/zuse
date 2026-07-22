import {
	type MutableRefObject,
	type Ref,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { TextInput } from "react-native";

import { colors } from "~/theme";

export type ComposerTextInputHandle = {
	getText: () => string;
	clear: () => void;
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
}) {
	const [text, setText] = useState(initialText);
	const textRef = useRef(initialText);
	const hadTextRef = useRef(initialText.trim().length > 0);
	const onPersistRef = useRef(onPersist);
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
		},
	}));

	const handleChange = (next: string) => {
		textRef.current = next;
		setText(next);
		const hasText = next.trim().length > 0;
		if (hasText !== hadTextRef.current) {
			hadTextRef.current = hasText;
			onHasTextChange(hasText);
		}
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
			onFocus={onFocus}
			onBlur={() => {
				onPersist(textRef.current);
				onBlur();
			}}
		/>
	);
}
