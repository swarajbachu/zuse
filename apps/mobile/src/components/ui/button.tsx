import { Children, forwardRef } from "react";
import { Pressable, Text, View, type PressableProps } from "react-native";

import { cn } from "~/lib/cn";

type ButtonProps = PressableProps & {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
};

function textClassName(variant: NonNullable<ButtonProps["variant"]>) {
  return cn(
    "font-sans-medium text-[17px]",
    variant === "primary" || variant === "danger" ? "text-primary-foreground" : "text-foreground"
  );
}

function renderButtonChild(child: React.ReactNode, variant: NonNullable<ButtonProps["variant"]>) {
  if (typeof child === "string" || typeof child === "number") {
    return <Text className={textClassName(variant)}>{child}</Text>;
  }

  return child;
}

export const Button = forwardRef<React.ElementRef<typeof Pressable>, ButtonProps>(
  ({ className, children, variant = "primary", size = "md", disabled, ...props }, ref) => (
    <Pressable
      ref={ref}
      disabled={disabled}
      style={{ borderCurve: "continuous" }}
      className={cn(
        "items-center justify-center rounded-xl border active:opacity-80",
        size === "sm" ? "h-9 px-3" : "h-12 px-4",
        variant === "primary" && "border-primary bg-primary",
        variant === "secondary" && "border-border bg-card-elevated",
        variant === "ghost" && "border-transparent bg-transparent",
        variant === "danger" && "border-danger bg-danger",
        disabled && "opacity-45",
        className
      )}
      {...props}
    >
      <View className="flex-row items-center justify-center gap-2">
        {Children.map(children, (child) => renderButtonChild(child, variant))}
      </View>
    </Pressable>
  )
);

Button.displayName = "Button";
