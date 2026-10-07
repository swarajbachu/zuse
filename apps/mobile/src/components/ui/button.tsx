import { Children, forwardRef } from "react";
import { Pressable, type PressableProps, Text, View } from "react-native";

import { cn } from "~/lib/cn";

type ButtonProps = PressableProps & {
	children: React.ReactNode;
	analyticsId?: string;
	variant?: "primary" | "secondary" | "ghost" | "danger";
	size?: "sm" | "md";
};

function textClassName(
	variant: NonNullable<ButtonProps["variant"]>,
	size: NonNullable<ButtonProps["size"]>,
) {
	return cn(
		"font-sans-medium",
		size === "sm" ? "text-[15px]" : "text-[16px]",
		variant === "danger"
			? "text-white"
			: variant === "primary"
				? "text-primary-foreground"
				: "text-foreground",
	);
}

function renderButtonChild(
	child: React.ReactNode,
	variant: NonNullable<ButtonProps["variant"]>,
	size: NonNullable<ButtonProps["size"]>,
) {
	if (typeof child === "string" || typeof child === "number") {
		return <Text className={textClassName(variant, size)}>{child}</Text>;
	}

	return child;
}

export const Button = forwardRef<
	React.ElementRef<typeof Pressable>,
	ButtonProps
>(
	(
		{
			className,
			children,
			variant = "primary",
			size = "md",
			disabled,
			analyticsId,
			onPress,
			...props
		},
		ref,
	) => (
		<Pressable
			ref={ref}
			disabled={disabled}
			// The 36pt small button keeps a 44pt touch target; callers may override.
			hitSlop={size === "sm" ? 4 : undefined}
			onPress={
				onPress
					? (event) => {
							if (analyticsId) {
								void import("~/lib/analytics").then(
									({ captureMobileControl }) =>
										captureMobileControl(analyticsId),
								);
							}
							onPress(event);
						}
					: undefined
			}
			style={{ borderCurve: "continuous" }}
			className={cn(
				"items-center justify-center rounded-full border active:opacity-80",
				size === "sm" ? "h-9 px-3.5" : "h-11 px-4",
				variant === "primary" && "border-primary bg-primary",
				variant === "secondary" && "border-border bg-card-elevated",
				variant === "ghost" && "border-transparent bg-transparent",
				variant === "danger" && "border-danger bg-danger",
				disabled && "opacity-45",
				className,
			)}
			{...props}
		>
			<View className="flex-row items-center justify-center gap-2">
				{Children.map(children, (child) =>
					renderButtonChild(child, variant, size),
				)}
			</View>
		</Pressable>
	),
);

Button.displayName = "Button";
