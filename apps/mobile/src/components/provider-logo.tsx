import type { ProviderId } from "@zuse/contracts";
import { type ColorValue, Image } from "react-native";

import { PROVIDER_LOGOS } from "~/lib/provider-logos";
import { colors } from "~/theme";

/**
 * A provider's brand mark at a fixed size. The bundled logos are template
 * silhouettes, so they're tinted (defaulting to the foreground colour) and read
 * correctly on both light and dark surfaces.
 */
export function ProviderLogo({
	providerId,
	size = 16,
	color = colors.fg,
}: {
	providerId: ProviderId;
	size?: number;
	color?: ColorValue;
}) {
	const source = PROVIDER_LOGOS[providerId];
	if (source === undefined) return null;
	return (
		<Image
			source={source}
			tintColor={color}
			resizeMode="contain"
			style={{ width: size, height: size }}
		/>
	);
}
