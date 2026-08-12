"use client";

import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { ChevronDown } from "lucide-react";
import type React from "react";
import { cn } from "~/lib/utils";

export function Accordion(
	props: AccordionPrimitive.Root.Props,
): React.ReactElement {
	return <AccordionPrimitive.Root data-slot="accordion" {...props} />;
}

export function AccordionItem({
	className,
	...props
}: AccordionPrimitive.Item.Props): React.ReactElement {
	return (
		<AccordionPrimitive.Item
			className={cn("border-b last:border-b-0", className)}
			data-slot="accordion-item"
			{...props}
		/>
	);
}

export function AccordionTrigger({
	className,
	children,
	...props
}: AccordionPrimitive.Trigger.Props): React.ReactElement {
	return (
		<AccordionPrimitive.Header className="flex">
			<AccordionPrimitive.Trigger
				className={cn(
					"flex min-h-7 flex-1 cursor-pointer items-center justify-between gap-2 rounded-md py-1.5 text-left font-medium text-xs outline-none transition-[color,background-color] duration-150 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 data-panel-open:*:data-[slot=accordion-indicator]:rotate-180",
					className,
				)}
				data-slot="accordion-trigger"
				{...props}
			>
				{children}
				<ChevronDown
					className="pointer-events-none size-4 shrink-0 translate-y-0.5 opacity-80 transition-transform duration-200 ease-in-out"
					data-slot="accordion-indicator"
				/>
			</AccordionPrimitive.Trigger>
		</AccordionPrimitive.Header>
	);
}

export function AccordionPanel({
	className,
	children,
	...props
}: AccordionPrimitive.Panel.Props): React.ReactElement {
	return (
		<AccordionPrimitive.Panel
			className="h-(--accordion-panel-height) overflow-hidden text-muted-foreground text-xs transition-[height] duration-180 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:duration-80"
			data-slot="accordion-panel"
			{...props}
		>
			<div className={cn("pt-0 pb-2.5", className)}>{children}</div>
		</AccordionPrimitive.Panel>
	);
}

export { AccordionPanel as AccordionContent, AccordionPrimitive };
