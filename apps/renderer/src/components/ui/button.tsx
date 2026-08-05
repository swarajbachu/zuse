"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

export const buttonVariants = cva(
	"relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium text-xs outline-none transition-[background-color,border-color,color,box-shadow] duration-150 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 data-loading:select-none data-loading:text-transparent [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0",
	{
		defaultVariants: {
			size: "default",
			variant: "default",
		},
		variants: {
			size: {
				default: "h-7 px-[calc(--spacing(2.5)-1px)]",
				icon: "size-7",
				"icon-lg": "size-8",
				"icon-sm": "size-6",
				"icon-xl": "size-9 [&_svg:not([class*='size-'])]:size-4",
				"icon-xs":
					"size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3",
				lg: "h-8 px-[calc(--spacing(3)-1px)]",
				sm: "h-6 gap-1 px-[calc(--spacing(2)-1px)] text-[11px]",
				xl: "h-9 px-[calc(--spacing(3.5)-1px)] text-[13px] [&_svg:not([class*='size-'])]:size-4",
				xs: "h-6 gap-1 px-[calc(--spacing(1.5)-1px)] text-[10px] [&_svg:not([class*='size-'])]:size-3",
			},
			variant: {
				default:
					"not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] border-primary bg-primary text-primary-foreground shadow-primary/24 shadow-xs hover:bg-primary/90 data-pressed:bg-primary/90 *:data-[slot=button-loading-indicator]:text-primary-foreground [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none btn-lime-embodied",
				destructive:
					"not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] border-destructive bg-destructive text-white shadow-destructive/24 shadow-xs hover:bg-destructive/90 data-pressed:bg-destructive/90 *:data-[slot=button-loading-indicator]:text-white [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none",
				"destructive-outline":
					"border-transparent bg-alert-error-bg text-destructive-foreground shadow-xs/5 ring-1 ring-inset ring-destructive/10 not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] hover:bg-alert-error-bg data-pressed:bg-alert-error-bg *:data-[slot=button-loading-indicator]:text-foreground dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/5%)] [:disabled,:active,[data-pressed]]:shadow-none",
				ghost:
					"border-transparent text-foreground hover:bg-accent data-pressed:bg-accent *:data-[slot=button-loading-indicator]:text-foreground",
				link: "border-transparent text-foreground underline-offset-4 hover:underline data-pressed:underline *:data-[slot=button-loading-indicator]:text-foreground",
				outline:
					"border-transparent bg-muted not-dark:bg-clip-padding text-foreground shadow-xs/5 ring-1 ring-inset ring-border/45 not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] hover:bg-accent data-pressed:bg-accent *:data-[slot=button-loading-indicator]:text-foreground dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/5%)] [:disabled,:active,[data-pressed]]:shadow-none",
				secondary:
					"border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/90 data-pressed:bg-secondary/90 *:data-[slot=button-loading-indicator]:text-secondary-foreground [:active,[data-pressed]]:bg-secondary/80",

				/* Subtle glass button (glassmorphic secondary) */
				subtle:
					"rounded-md border border-white/10 bg-neutral-primary-reverted-5 px-2.5 text-xs font-semibold text-foreground shadow-none backdrop-blur-[12px] hover:bg-white/8 active:bg-white/12 data-pressed:bg-white/12 *:data-[slot=button-loading-indicator]:text-foreground before:hidden",

				/* Settings: flat translucent action button used on settings rows. */
			settings:
				"h-7 rounded-md border-white/8 bg-neutral-primary-reverted-20 px-2.5 text-xs text-foreground/90 shadow-none hover:bg-white/14 active:bg-white/16 data-pressed:bg-white/16 *:data-[slot=button-loading-indicator]:text-foreground before:hidden",
			},
		},
	},
);

export interface ButtonProps extends useRender.ComponentProps<"button"> {
	variant?: VariantProps<typeof buttonVariants>["variant"];
	size?: VariantProps<typeof buttonVariants>["size"];
	loading?: boolean;
}

export function Button({
	className,
	variant,
	size,
	render,
	children,
	loading = false,
	disabled: disabledProp,
	...props
}: ButtonProps): React.ReactElement {
	const isDisabled: boolean = Boolean(loading || disabledProp);
	const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] =
		render ? undefined : "button";

	const defaultProps = {
		children: (
			<>
				{children}
				{loading && (
					<Spinner
						className="pointer-events-none absolute"
						data-slot="button-loading-indicator"
					/>
				)}
			</>
		),
		className: cn(buttonVariants({ className, size, variant })),
		"aria-disabled": loading || undefined,
		"data-loading": loading ? "" : undefined,
		"data-slot": "button",
		disabled: isDisabled,
		type: typeValue,
	};

	return useRender({
		defaultTagName: "button",
		props: mergeProps<"button">(defaultProps, props),
		render,
	});
}
