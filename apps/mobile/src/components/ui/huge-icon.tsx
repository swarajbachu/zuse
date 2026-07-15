import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react-native";
import type { ColorValue } from "react-native";

type HugeIconProps = {
	icon: IconSvgElement;
	size?: number;
	color: ColorValue;
};

export const HugeIcon = ({ icon, size = 16, color }: HugeIconProps) => (
	<HugeiconsIcon icon={icon} size={size} color={color} />
);
