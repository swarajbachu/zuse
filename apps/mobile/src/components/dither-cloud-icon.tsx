import { DITHER_CLOUD_PATH } from "@zuse/icons/dither-cloud";
import Svg, { Path } from "react-native-svg";
import { colors } from "~/theme";
export function DitherCloudIcon({ size = 20 }: { size?: number }) {
	return (
		<Svg
			width={size}
			height={size}
			viewBox="0 0 40 40"
			accessibilityLabel="Cloud chat"
		>
			<Path d={DITHER_CLOUD_PATH} fill={colors.secondaryFg} />
		</Svg>
	);
}
