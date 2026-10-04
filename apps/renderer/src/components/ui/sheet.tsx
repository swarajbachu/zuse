"use client";

import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { X } from "lucide-react";
import type React from "react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { DialogBackdrop } from "./dialog.tsx";

/** A modal side panel for long, list-shaped forms. Shares Dialog semantics. */
export const Sheet: typeof SheetPrimitive.Root = SheetPrimitive.Root;

export function SheetClose(
	props: SheetPrimitive.Close.Props,
): React.ReactElement {
	return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

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
			<DialogBackdrop />
			<SheetPrimitive.Viewport className="fixed inset-0 z-50 flex justify-end p-2">
				<SheetPrimitive.Popup
					className={cn(
						"relative flex h-full w-full max-w-2xl min-w-0 flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-overlay-lg outline-none transition-[translate,opacity] duration-200 ease-out data-ending-style:translate-x-6 data-ending-style:opacity-0 data-starting-style:translate-x-6 data-starting-style:opacity-0 motion-reduce:transition-opacity motion-reduce:data-ending-style:translate-x-0 motion-reduce:data-starting-style:translate-x-0 dark:border dark:border-white/10",
						className,
					)}
					data-slot="sheet-popup"
					{...props}
				>
					{children}
					{showCloseButton ? (
						<SheetPrimitive.Close
							aria-label={uiMessage("common:close")}
							className="absolute end-2 top-2"
							render={<Button size="icon" variant="ghost" />}
						>
							<X />
						</SheetPrimitive.Close>
					) : null}
				</SheetPrimitive.Popup>
			</SheetPrimitive.Viewport>
		</SheetPrimitive.Portal>
	);
}

export function SheetHeader({
	className,
	...props
}: React.ComponentProps<"div">): React.ReactElement {
	return (
		<div
			className={cn("flex shrink-0 flex-col gap-1 px-4 pt-4 pb-3", className)}
			data-slot="sheet-header"
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
			className={cn(
				"font-heading font-semibold text-[15px] leading-none",
				className,
			)}
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

/** The scrolling region between a fixed header and footer. */
export function SheetBody({
	className,
	...props
}: React.ComponentProps<"div">): React.ReactElement {
	return (
		<div
			className={cn("min-h-0 flex-1 overflow-y-auto px-4 pb-4", className)}
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
				"flex shrink-0 items-center gap-1.5 border-t border-border/60 bg-muted/72 px-4 py-2.5",
				className,
			)}
			data-slot="sheet-footer"
			{...props}
		/>
	);
}
