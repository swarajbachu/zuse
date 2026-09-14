import type {
	ExtensionClientContext,
	ExtensionThemeContribution,
} from "@zuse/extension-sdk";
import colors from "./fixtures/palette.json";

export const theme: ExtensionThemeContribution = {
	id: "midnight-ocean",
	name: "Midnight Ocean",
	appearance: "dark",
	theme: { colors },
};
export default function setup(context: ExtensionClientContext) {
	context.addTheme(theme);
	return () => {};
}
