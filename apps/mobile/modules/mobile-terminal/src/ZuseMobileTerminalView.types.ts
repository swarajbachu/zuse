import type { ViewProps } from "react-native";

export type TerminalInputEvent = {
	readonly nativeEvent: { readonly data: string };
};

export type TerminalResizeEvent = {
	readonly nativeEvent: {
		readonly cols: number;
		readonly rows: number;
	};
};

export type TerminalLinkEvent = {
	readonly nativeEvent: { readonly url: string };
};

export type ZuseMobileTerminalViewProps = ViewProps & {
	/**
	 * A sequence-prefixed terminal output chunk. The prefix makes repeated PTY
	 * chunks observable by React Native without retaining the transcript in JS.
	 */
	readonly feed?: string;
	readonly fontSize?: number;
	readonly focusNonce?: number;
	readonly controlNonce?: number;
	readonly useMetal?: boolean;
	readonly onInput?: (event: TerminalInputEvent) => void;
	readonly onResize?: (event: TerminalResizeEvent) => void;
	readonly onOpenLink?: (event: TerminalLinkEvent) => void;
};
