import type { LucideIcon } from "lucide-react-native";
import { Pressable, type PressableProps } from "react-native";

import { cn } from "~/lib/cn";
import { colors } from "~/theme";

type IconButtonProps = PressableProps & {
	icon: LucideIcon;
	label: string;
	tone?: "default" | "primary" | "danger";
};

export const IconButton = ({
	icon: Icon,
	label,
	tone = "default",
	className,
	...props
}: IconButtonProps) => (
	<Pressable
		accessibilityLabel={label}
		className={cn(
			"h-10 w-10 items-center justify-center rounded-lg border active:opacity-80",
			tone === "primary"
				? "border-primary bg-primary"
				: "border-border bg-card",
			tone === "danger" && "border-danger",
			className,
		)}
		{...props}
	>
		<Icon size={18} color={tone === "primary" ? colors.bg : colors.fg} />
	</Pressable>
);
