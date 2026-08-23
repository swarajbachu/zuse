import type { ComponentType } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { ZuseMobileTerminalViewProps } from "./ZuseMobileTerminalView.types";

/** Android keeps the route boundary safe until a native terminal adapter ships. */
export const ZuseMobileTerminalView: ComponentType<
	ZuseMobileTerminalViewProps
> = ({ style }) => (
	<View style={[styles.container, style]}>
		<Text style={styles.label}>
			Interactive terminals are currently available on iPhone.
		</Text>
	</View>
);

const styles = StyleSheet.create({
	container: {
		alignItems: "center",
		backgroundColor: "#111111",
		justifyContent: "center",
		paddingHorizontal: 24,
	},
	label: {
		color: "#a3a3a3",
		fontSize: 14,
		textAlign: "center",
	},
});

export type {
	TerminalInputEvent,
	TerminalLinkEvent,
	TerminalResizeEvent,
	ZuseMobileTerminalViewProps,
} from "./ZuseMobileTerminalView.types";
