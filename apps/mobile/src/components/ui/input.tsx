import { forwardRef } from "react";
import { TextInput, type TextInputProps } from "react-native";

import { cn } from "~/lib/cn";

export const Input = forwardRef<TextInput, TextInputProps>(
  ({ className, placeholderTextColor = "hsl(72 2% 64%)", ...props }, ref) => (
    <TextInput
      ref={ref}
      placeholderTextColor={placeholderTextColor}
      className={cn(
        "h-11 rounded-lg border border-border bg-card px-3 font-sans text-foreground",
        className
      )}
      {...props}
    />
  )
);

Input.displayName = "Input";
