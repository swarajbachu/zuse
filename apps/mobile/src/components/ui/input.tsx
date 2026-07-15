import { forwardRef } from "react";
import { TextInput, type TextInputProps } from "react-native";

import { cn } from "~/lib/cn";
import { colors } from "~/theme";

export const Input = forwardRef<TextInput, TextInputProps>(
	({ className, placeholderTextColor = colors.secondaryFg, ...props }, ref) => (
		<TextInput
			ref={ref}
			placeholderTextColor={placeholderTextColor}
			className={cn(
				"h-11 rounded-lg border border-border bg-card px-3 font-sans text-foreground",
				className,
			)}
			{...props}
		/>
	),
);

Input.displayName = "Input";
