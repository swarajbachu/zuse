"use client";

import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { X } from "lucide-react";
import type React from "react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export const Sheet: typeof SheetPrimitive.Root = SheetPrimitive.Root;

/** Full-height panel that slides in from the right edge. */
export function SheetPopup({
	className,
	children,
	showCloseButton = true,
	...props
}: SheetPrimitive.Popup.Props & {
	showCloseButton?: boolean;
}): React.ReactElement {
	const { message: uiMessage } = useUiMessages(["common"]);
	return (
		<SheetPrimitive.Portal>
			<SheetPrimitive.Backdrop
				className="fixed inset-0 z-50 bg-black/24 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:duration-80"
				data-slot="sheet-backdrop"
			/>
			<SheetPrimitive.Popup
				className={cn(
					"fixed inset-y-0 right-0 z-50 flex w-[min(560px,100vw)] flex-col bg-popover text-popover-foreground shadow-overlay-lg outline-none transition-transform duration-200 ease-out data-ending-style:translate-x-full data-starting-style:translate-x-full motion-reduce:transition-none dark:border-l dark:border-white/10",
					className,
				)}
				data-slot="sheet-popup"
				{...props}
			>
				{children}
				{showCloseButton && (
					<SheetPrimitive.Close
						aria-label={uiMessage("common:close")}
						className="absolute end-3 top-3"
						render={<Button size="icon" variant="ghost" />}
					>
						<X />
					</SheetPrimitive.Close>
				)}
			</SheetPrimitive.Popup>
		</SheetPrimitive.Portal>
	);
}

export function SheetHeader({
	className,
	...props
}: React.ComponentProps<"div">): React.ReactElement {
	return (
		<div
			className={cn(
				"flex shrink-0 items-center gap-3 px-5 pt-4 pb-3",
				className,
			)}
			data-slot="sheet-header"
			{...props}
		/>
	);
}

export function SheetBody({
	className,
	...props
}: React.ComponentProps<"div">): React.ReactElement {
	return (
		<div
			className={cn("min-h-0 flex-1 overflow-y-auto px-5 pb-6", className)}
			data-slot="sheet-body"
			{...props}
		/>
	);
}

export function SheetFooter({
	className,
	...props
}: React.ComponentProps<"div">): React.ReactElement {
	return (
		<div
			className={cn(
				"flex shrink-0 items-center gap-2 border-t border-border/60 px-5 py-3",
				className,
			)}
			data-slot="sheet-footer"
			{...props}
		/>
	);
}

export function SheetTitle({
	className,
	...props
}: SheetPrimitive.Title.Props): React.ReactElement {
	return (
		<SheetPrimitive.Title
			className={cn("font-heading font-semibold text-sm", className)}
			data-slot="sheet-title"
			{...props}
		/>
	);
}

export function SheetDescription({
	className,
	...props
}: SheetPrimitive.Description.Props): React.ReactElement {
	return (
		<SheetPrimitive.Description
			className={cn("text-muted-foreground text-[11px]", className)}
			data-slot="sheet-description"
			{...props}
		/>
	);
}
