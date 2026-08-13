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
				"group/switch relative inline-flex h-5 w-8 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-all duration-150 outline-none",
				"ring-1 ring-(--color-neutral-primary-reverted-20,#ffffff1a)",
				"data-checked:bg-primary data-checked:ring-primary/60",
				"data-unchecked:bg-[#1f2123] dark:data-unchecked:bg-[#1c1e20]",
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
					"shadow-[0_1px_2px_rgba(0,0,0,0.1)] bg-linear-to-b from-black/0 to-black/8",
					"ring-1",
					// Light mode
					"bg-white ring-black/10",
					// Dark mode — balanced dark knob that looks good on bright lime
					// (darker than light gray, but not as heavy/black as the surface)
					"dark:bg-[#484a4d] dark:ring-[#2a2c2e]",
					// When switch is on (lime track), give the knob a crisper ring so it pops nicely
					"data-checked:dark:ring-[#3a3c3e]",
					"data-unchecked:ml-0 data-checked:ml-[14px]",
					"group-active/switch:scale-[0.92]",
				)}
				data-slot="switch-thumb"
			/>
		</SwitchPrimitive.Root>
	);
}

export { SwitchPrimitive };
