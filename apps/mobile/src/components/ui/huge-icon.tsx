import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react-native";
import type { ColorValue } from "react-native";

type HugeIconProps = {
	icon: IconSvgElement;
	size?: number;
	color: ColorValue;
	strokeWidth?: number;
};

export const HugeIcon = ({
	icon,
	size = 16,
	color,
	strokeWidth = 1,
}: HugeIconProps) => (
	<HugeiconsIcon
		icon={icon}
		size={size}
		color={color}
		strokeWidth={strokeWidth}
	/>
);
