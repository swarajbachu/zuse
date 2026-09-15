import type {
	ExtensionClientContext,
	ExtensionThemeContribution,
} from "@zuse/extension-sdk";
import colors from "./fixtures/palette.json";

export const theme: ExtensionThemeContribution = {
	id: "warm-paper",
	name: "Warm Paper",
	appearance: "light",
	theme: { colors },
};
export default function setup(context: ExtensionClientContext) {
	context.addTheme(theme);
	return () => {};
}
