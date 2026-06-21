"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type React from "react";
import { cn } from "~/lib/utils";

export const badgeVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-[0.1875rem] border border-transparent font-medium outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [button&,a&]:cursor-pointer [button&,a&]:pointer-coarse:after:absolute [button&,a&]:pointer-coarse:after:size-full [button&,a&]:pointer-coarse:after:min-h-11 [button&,a&]:pointer-coarse:after:min-w-11",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default:
          "h-5.5 min-w-5.5 px-[calc(--spacing(1)-1px)] text-sm sm:h-4.5 sm:min-w-4.5 sm:text-xs",
        lg: "h-6.5 min-w-6.5 px-[calc(--spacing(1.5)-1px)] text-base sm:h-5.5 sm:min-w-5.5 sm:text-sm",
        sm: "h-5 min-w-5 rounded-[0.15625rem] px-[calc(--spacing(1)-1px)] text-xs sm:h-4 sm:min-w-4 sm:text-[.625rem]",
      },
      variant: {
        default:
          "bg-primary text-primary-foreground [button&,a&]:hover:bg-primary/90",
        destructive:
          "bg-destructive text-white [button&,a&]:hover:bg-destructive/90",
        error:
          "bg-alert-error-bg text-destructive-foreground ring-1 ring-inset ring-destructive/10",
        info: "bg-alert-info-bg text-info-foreground ring-1 ring-inset ring-info/10",
        outline:
          "bg-muted text-foreground ring-1 ring-inset ring-border/45 [button&,a&]:hover:bg-accent",
        secondary:
          "bg-secondary text-secondary-foreground [button&,a&]:hover:bg-secondary/90",
        success:
          "bg-alert-success-bg text-success-foreground ring-1 ring-inset ring-success/10",
        warning:
          "bg-alert-warning-bg text-warning-foreground ring-1 ring-inset ring-warning/10",
      },
    },
  },
);

export interface BadgeProps extends useRender.ComponentProps<"span"> {
  variant?: VariantProps<typeof badgeVariants>["variant"];
  size?: VariantProps<typeof badgeVariants>["size"];
}

export function Badge({
  className,
  variant,
  size,
  render,
  ...props
}: BadgeProps): React.ReactElement {
  const defaultProps = {
    className: cn(badgeVariants({ className, size, variant })),
    "data-slot": "badge",
  };

  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}
