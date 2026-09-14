"use client";

import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({
	className,
	children,
	...props
}: SelectPrimitive.Trigger.Props) {
	return (
		<SelectPrimitive.Trigger
			data-slot="select-trigger"
			className={cn(
				"inline-flex h-7 shrink-0 items-center justify-between gap-1 rounded-md border border-border bg-card px-2 text-xs font-medium text-heading outline-none transition-colors hover:bg-elevated focus-visible:ring-2 focus-visible:ring-heading/60 data-disabled:pointer-events-none data-disabled:opacity-50",
				className,
			)}
			{...props}
		>
			{children}
			<SelectPrimitive.Icon>
				<ChevronDown
					aria-hidden="true"
					className="size-3 text-muted-foreground"
				/>
			</SelectPrimitive.Icon>
		</SelectPrimitive.Trigger>
	);
}

export function SelectContent({
	children,
	className,
	...props
}: SelectPrimitive.Popup.Props) {
	return (
		<SelectPrimitive.Portal>
			<SelectPrimitive.Positioner
				align="end"
				sideOffset={6}
				alignItemWithTrigger={false}
				className="z-50"
			>
				<SelectPrimitive.Popup
					data-slot="select-content"
					className={cn(
						"min-w-40 max-w-(--available-width) overflow-hidden rounded-lg border border-border bg-card p-1 text-heading shadow-lg outline-none",
						className,
					)}
					{...props}
				>
					<SelectPrimitive.List className="max-h-(--available-height) overflow-y-auto">
						{children}
					</SelectPrimitive.List>
				</SelectPrimitive.Popup>
			</SelectPrimitive.Positioner>
		</SelectPrimitive.Portal>
	);
}

export function SelectItem({
	children,
	className,
	...props
}: SelectPrimitive.Item.Props) {
	return (
		<SelectPrimitive.Item
			data-slot="select-item"
			className={cn(
				"relative flex h-7 cursor-default select-none items-center rounded-md py-1 pr-7 pl-2 text-xs outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-50",
				className,
			)}
			{...props}
		>
			<SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
			<SelectPrimitive.ItemIndicator className="absolute right-2 flex items-center">
				<Check aria-hidden="true" className="size-3.5" />
			</SelectPrimitive.ItemIndicator>
		</SelectPrimitive.Item>
	);
}
