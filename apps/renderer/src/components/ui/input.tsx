"use client";

import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";
import { cn } from "~/lib/utils";

export type InputProps = Omit<
	InputPrimitive.Props & React.RefAttributes<HTMLInputElement>,
	"size"
> & {
	size?: "sm" | "default" | "lg" | number;
	unstyled?: boolean;
	nativeInput?: boolean;
};

export function Input({
	className,
	size = "default",
	unstyled = false,
	nativeInput = false,
	style,
	...props
}: InputProps): React.ReactElement {
	const inputClassName = cn(
		"h-7 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(2.5)-1px)] leading-7 outline-none [transition:background-color_5000000s_ease-in-out_0s] placeholder:text-muted-foreground/72",
		size === "sm" && "h-6 px-[calc(--spacing(2)-1px)] leading-6",
		size === "lg" && "h-8 leading-8",
		props.type === "search" &&
			"[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none",
		props.type === "file" &&
			"text-muted-foreground file:me-3 file:bg-transparent file:font-medium file:text-foreground file:text-sm",
	);

	return (
		<span
			className={
				cn(
					!unstyled &&
						"relative inline-flex w-full rounded-md border border-input bg-card not-dark:bg-clip-padding text-xs text-foreground shadow-xs/5 ring-ring/24 transition-[border-color,box-shadow] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-autofill:bg-foreground/4 has-disabled:cursor-not-allowed has-disabled:opacity-64 has-focus-visible:ring-2 dark:bg-card dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24",
					className,
				) || undefined
			}
			data-size={size}
			data-slot="input-control"
		>
			{nativeInput ? (
				<input
					className={inputClassName}
					data-slot="input"
					size={typeof size === "number" ? size : undefined}
					style={typeof style === "function" ? undefined : style}
					{...props}
				/>
			) : (
				<InputPrimitive
					className={inputClassName}
					data-slot="input"
					size={typeof size === "number" ? size : undefined}
					style={style}
					{...props}
				/>
			)}
		</span>
	);
}

export { InputPrimitive };
