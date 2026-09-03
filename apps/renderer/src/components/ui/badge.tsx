"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type React from "react";
import { cn } from "~/lib/utils";

export const badgeVariants = cva(
	"relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full font-medium outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3 sm:[&_svg:not([class*='size-'])]:size-2.5 [&_svg]:pointer-events-none [&_svg]:shrink-0 [button&,a&]:cursor-pointer [button&,a&]:pointer-coarse:after:absolute [button&,a&]:pointer-coarse:after:size-full [button&,a&]:pointer-coarse:after:min-h-11 [button&,a&]:pointer-coarse:after:min-w-11",
	{
		defaultVariants: {
			size: "default",
			variant: "default",
		},
		variants: {
			size: {
				default:
					"h-5 min-w-5 px-1.5 text-xs sm:h-4 sm:min-w-4 sm:text-[.625rem]",
				lg: "h-6 min-w-6 px-2 text-sm sm:h-5 sm:min-w-5 sm:text-xs",
				sm: "h-4.5 min-w-4.5 px-1 text-[.625rem] sm:h-3.5 sm:min-w-3.5 sm:text-[.5625rem]",
			},
			variant: {
				default:
					"bg-primary/50 text-primary-foreground [button&,a&]:hover:bg-primary/60",
				destructive:
					"bg-destructive/50 text-white [button&,a&]:hover:bg-destructive/60",
				error: "bg-alert-error-bg text-destructive",
				info: "bg-alert-info-bg text-info",
				outline: "bg-muted/50 text-foreground [button&,a&]:hover:bg-accent/60",
				secondary:
					"bg-secondary/50 text-secondary-foreground [button&,a&]:hover:bg-secondary/60",
				success: "bg-alert-success-bg text-success",
				warning: "bg-alert-warning-bg text-warning",
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
