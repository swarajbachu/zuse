"use client";

import { Field as FieldPrimitive } from "@base-ui/react/field";
import { mergeProps } from "@base-ui/react/merge-props";
import type * as React from "react";
import { cn } from "~/lib/utils";

export type TextareaProps = React.ComponentPropsWithoutRef<"textarea"> &
	React.RefAttributes<HTMLTextAreaElement> & {
		size?: "sm" | "default" | "lg" | number;
		unstyled?: boolean;
	};

export function Textarea({
	className,
	size = "default",
	unstyled = false,
	ref,
	...props
}: TextareaProps): React.ReactElement {
	return (
		<span
			className={
				cn(
					!unstyled &&
						"relative inline-flex w-full rounded-md border border-input bg-card text-xs text-foreground shadow-xs/5 ring-ring/24 transition-[border-color,box-shadow] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-disabled:cursor-not-allowed has-disabled:opacity-64 has-focus-visible:ring-2 dark:bg-card dark:has-aria-invalid:ring-destructive/24",
					className,
				) || undefined
			}
			data-size={size}
			data-slot="textarea-control"
		>
			<FieldPrimitive.Control
				ref={ref}
				value={props.value}
				defaultValue={props.defaultValue}
				disabled={props.disabled}
				id={props.id}
				name={props.name}
				render={(defaultProps: React.ComponentProps<"textarea">) => (
					<textarea
						className={cn(
							"field-sizing-content min-h-14 w-full rounded-[inherit] px-[calc(--spacing(2.5)-1px)] py-1.5 outline-none",
							size === "sm" && "min-h-12 px-[calc(--spacing(2)-1px)] py-1",
							size === "lg" && "min-h-16 py-2",
						)}
						data-slot="textarea"
						{...mergeProps(defaultProps, props)}
					/>
				)}
			/>
		</span>
	);
}

export { FieldPrimitive };
