import { forwardRef } from "react";
import { Pressable, Text, View, type PressableProps } from "react-native";

import { cn } from "~/lib/cn";

type ButtonProps = PressableProps & {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
};

export const Button = forwardRef<React.ElementRef<typeof Pressable>, ButtonProps>(
  ({ className, children, variant = "primary", size = "md", disabled, ...props }, ref) => (
    <Pressable
      ref={ref}
      disabled={disabled}
      className={cn(
        "items-center justify-center rounded-lg border active:opacity-80",
        size === "sm" ? "h-9 px-3" : "h-11 px-4",
        variant === "primary" && "border-primary bg-primary",
        variant === "secondary" && "border-border bg-card-elevated",
        variant === "ghost" && "border-transparent bg-transparent",
        variant === "danger" && "border-danger bg-danger",
        disabled && "opacity-45",
        className
      )}
      {...props}
    >
      {typeof children === "string" ? (
        <Text
          className={cn(
            "font-sans-medium text-sm",
            variant === "primary" || variant === "danger"
              ? "text-primary-foreground"
              : "text-foreground"
          )}
        >
          {children}
        </Text>
      ) : (
        <View className="flex-row items-center justify-center gap-2">{children}</View>
      )}
    </Pressable>
  )
);

Button.displayName = "Button";
