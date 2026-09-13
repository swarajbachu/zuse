/** Enter/Escape during IME composition belong to the input method, including keyCode 229 engines. */
export function isInputComposing(event: {
	readonly isComposing?: boolean;
	readonly keyCode?: number;
	readonly nativeEvent?: {
		readonly isComposing?: boolean;
		readonly keyCode?: number;
	};
}): boolean {
	const native = event.nativeEvent ?? event;
	return native.isComposing === true || native.keyCode === 229;
}
