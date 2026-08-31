"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import type React from "react";
import { cn } from "~/lib/utils";

export function Switch({
	className,
	...props
}: SwitchPrimitive.Root.Props): React.ReactElement {
	return (
		<SwitchPrimitive.Root
			className={cn(
				"group/switch relative inline-flex h-5 w-8 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-[background-color,box-shadow] duration-150 outline-none",
				"ring-1 ring-inset ring-border",
				"data-checked:bg-primary data-checked:ring-primary/60",
				"data-unchecked:bg-bg-overlay dark:data-unchecked:bg-bg-elevated",
				"focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
				"data-disabled:cursor-not-allowed data-disabled:opacity-50",
				className,
			)}
			data-slot="switch"
			{...props}
		>
			<SwitchPrimitive.Thumb
				className={cn(
					"relative block size-3.5 rounded-full transition-all duration-120 ease-out",
					"bg-white shadow-[0_1px_2px_rgba(0,0,0,0.16)] ring-1 ring-black/10 dark:bg-foreground dark:ring-black/30",
					"data-unchecked:ml-0 data-checked:ml-[14px]",
					"group-active/switch:scale-[0.92]",
				)}
				data-slot="switch-thumb"
			/>
		</SwitchPrimitive.Root>
	);
}

export { SwitchPrimitive };
