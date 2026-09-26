import { Stack } from "expo-router";
import { colors } from "~/theme";
export default function SettingsLayout() {
	return (
		<Stack
			screenOptions={{
				headerLargeTitle: false,
				headerTransparent: true,
				headerBackButtonDisplayMode: "minimal",
				headerTintColor: colors.fg,
				contentStyle: { backgroundColor: colors.bg },
			}}
		/>
	);
}
