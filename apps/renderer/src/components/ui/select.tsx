"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { useRender } from "@base-ui/react/use-render";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowDown01Icon,
	ArrowUp01Icon,
	ArrowUpDownIcon,
} from "@hugeicons-pro/core-solid-rounded";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "~/lib/utils";

export const Select: typeof SelectPrimitive.Root = SelectPrimitive.Root;

export const selectTriggerVariants = cva(
	"relative inline-flex min-h-7 w-full min-w-28 select-none items-center justify-between gap-1.5 rounded-md border border-input bg-background px-[calc(--spacing(2.5)-1px)] text-left text-xs text-foreground shadow-none outline-none ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 focus-visible:border-ring focus-visible:ring-2 aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 focus-visible:aria-invalid:ring-destructive/16 data-disabled:pointer-events-none data-disabled:opacity-64 dark:bg-input/32 dark:aria-invalid:ring-destructive/24 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:pointer-events-none [&_svg]:shrink-0",
	{
		defaultVariants: {
			size: "default",
		},
		variants: {
			size: {
				default: "",
				lg: "min-h-8",
				sm: "min-h-6 gap-1 px-[calc(--spacing(2)-1px)] text-[11px]",
			},
		},
	},
);

export const selectTriggerIconClassName = "-me-1 size-3.5 opacity-80";

export interface SelectButtonProps extends useRender.ComponentProps<"button"> {
	size?: VariantProps<typeof selectTriggerVariants>["size"];
}

export function SelectButton({
	className,
	size,
	render,
	children,
	...props
}: SelectButtonProps): React.ReactElement {
	const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] =
		render ? undefined : "button";

	const defaultProps = {
		children: (
			<>
				<span className="flex-1 truncate in-data-placeholder:text-muted-foreground/72">
					{children}
				</span>
				<HugeiconsIcon
					icon={ArrowUpDownIcon}
					className={selectTriggerIconClassName}
				/>
			</>
		),
		className: cn(selectTriggerVariants({ size }), "min-w-0", className),
		"data-slot": "select-button",
		type: typeValue,
	};

	return useRender({
		defaultTagName: "button",
		props: mergeProps<"button">(defaultProps, props),
		render,
	});
}

export function SelectTrigger({
	className,
	size = "default",
	children,
	...props
}: SelectPrimitive.Trigger.Props &
	VariantProps<typeof selectTriggerVariants>): React.ReactElement {
	return (
		<SelectPrimitive.Trigger
			className={cn(selectTriggerVariants({ size }), className)}
			data-slot="select-trigger"
			{...props}
		>
			{children}
			<SelectPrimitive.Icon data-slot="select-icon">
				<HugeiconsIcon
					icon={ArrowUpDownIcon}
					className={selectTriggerIconClassName}
				/>
			</SelectPrimitive.Icon>
		</SelectPrimitive.Trigger>
	);
}

export function SelectValue({
	className,
	...props
}: SelectPrimitive.Value.Props): React.ReactElement {
	return (
		<SelectPrimitive.Value
			className={cn(
				"flex-1 truncate data-placeholder:text-muted-foreground",
				className,
			)}
			data-slot="select-value"
			{...props}
		/>
	);
}

export function SelectPopup({
	className,
	children,
	side = "bottom",
	sideOffset = 4,
	align = "start",
	alignOffset = 0,
	alignItemWithTrigger = true,
	anchor,
	portalProps,
	...props
}: SelectPrimitive.Popup.Props & {
	portalProps?: SelectPrimitive.Portal.Props;
	side?: SelectPrimitive.Positioner.Props["side"];
	sideOffset?: SelectPrimitive.Positioner.Props["sideOffset"];
	align?: SelectPrimitive.Positioner.Props["align"];
	alignOffset?: SelectPrimitive.Positioner.Props["alignOffset"];
	alignItemWithTrigger?: SelectPrimitive.Positioner.Props["alignItemWithTrigger"];
	anchor?: SelectPrimitive.Positioner.Props["anchor"];
}): React.ReactElement {
	return (
		<SelectPrimitive.Portal {...portalProps}>
			<SelectPrimitive.Positioner
				align={align}
				alignItemWithTrigger={alignItemWithTrigger}
				alignOffset={alignOffset}
				anchor={anchor}
				className="z-50 select-none"
				data-slot="select-positioner"
				side={side}
				sideOffset={sideOffset}
			>
				<SelectPrimitive.Popup
					className="origin-(--transform-origin) text-foreground outline-none"
					data-slot="select-popup"
					{...props}
				>
					<SelectPrimitive.ScrollUpArrow
						className="top-0 z-50 flex h-6 w-full cursor-default items-center justify-center before:pointer-events-none before:absolute before:inset-x-px before:top-px before:h-[200%] before:rounded-t-[calc(var(--radius-xl)-1px)] before:bg-linear-to-b before:from-50% before:from-popover"
						data-slot="select-scroll-up-arrow"
					>
						<HugeiconsIcon
							icon={ArrowUp01Icon}
							className="relative size-4.5 sm:size-4"
						/>
					</SelectPrimitive.ScrollUpArrow>
					<div className="relative h-full min-w-(--anchor-width) rounded-lg bg-glass border-glass">
						<SelectPrimitive.List
							className={cn(
								"max-h-(--available-height) overflow-y-auto rounded-lg p-1",
								className,
							)}
							data-slot="select-list"
						>
							{children}
						</SelectPrimitive.List>
					</div>
					<SelectPrimitive.ScrollDownArrow
						className="bottom-0 z-50 flex h-6 w-full cursor-default items-center justify-center before:pointer-events-none before:absolute before:inset-x-px before:bottom-px before:h-[200%] before:rounded-b-[calc(var(--radius-xl)-1px)] before:bg-linear-to-t before:from-50% before:from-popover"
						data-slot="select-scroll-down-arrow"
					>
						<HugeiconsIcon
							icon={ArrowDown01Icon}
							className="relative size-4.5 sm:size-4"
						/>
					</SelectPrimitive.ScrollDownArrow>
				</SelectPrimitive.Popup>
			</SelectPrimitive.Positioner>
		</SelectPrimitive.Portal>
	);
}

export function SelectItem({
	className,
	children,
	...props
}: SelectPrimitive.Item.Props): React.ReactElement {
	return (
		<SelectPrimitive.Item
			className={cn(
				"grid min-h-6 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1rem)] cursor-default grid-cols-[0.875rem_1fr] items-center gap-1.5 rounded-md py-0.5 ps-1.5 pe-3 text-xs outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				className,
			)}
			data-slot="select-item"
			{...props}
		>
			<SelectPrimitive.ItemIndicator className="col-start-1">
				<svg
					aria-hidden="true"
					fill="none"
					height="24"
					stroke="currentColor"
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth="2"
					viewBox="0 0 24 24"
					width="24"
					xmlns="http://www.w3.org/2000/svg"
				>
					<path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
				</svg>
			</SelectPrimitive.ItemIndicator>
			<SelectPrimitive.ItemText className="col-start-2 min-w-0">
				{children}
			</SelectPrimitive.ItemText>
		</SelectPrimitive.Item>
	);
}

export function SelectSeparator({
	className,
	...props
}: SelectPrimitive.Separator.Props): React.ReactElement {
	return (
		<SelectPrimitive.Separator
			className={cn("-mx-1.5 my-1 h-px bg-border/70", className)}
			data-slot="select-separator"
			{...props}
		/>
	);
}

export function SelectGroup(
	props: SelectPrimitive.Group.Props,
): React.ReactElement {
	return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

export function SelectLabel({
	className,
	...props
}: SelectPrimitive.Label.Props): React.ReactElement {
	return (
		<SelectPrimitive.Label
			className={cn(
				"not-in-data-[slot=field]:mb-2 inline-flex cursor-default items-center gap-2 font-medium text-base/4.5 text-foreground sm:text-sm/4",
				className,
			)}
			data-slot="select-label"
			{...props}
		/>
	);
}

export function SelectGroupLabel(
	props: SelectPrimitive.GroupLabel.Props,
): React.ReactElement {
	return (
		<SelectPrimitive.GroupLabel
			className="px-2 py-1.5 font-medium text-muted-foreground text-xs"
			data-slot="select-group-label"
			{...props}
		/>
	);
}

export { SelectPopup as SelectContent, SelectPrimitive };
