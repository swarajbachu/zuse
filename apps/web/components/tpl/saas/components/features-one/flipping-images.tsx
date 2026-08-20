"use client";

import { IconCheck, IconDeviceDesktop, IconPhoto } from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import { GridLineHorizontal, GridLineVertical } from "../grid-lines";

export function FlippingImagesWithBar() {
	const reduceMotion = useReducedMotion();
	return (
		<div className="mx-auto max-w-xl">
			<div className="bg-foreground/5 relative h-60 w-52 rounded-lg p-4">
				<GridLineHorizontal className="top-0" offset="200px" />
				<GridLineHorizontal className="bottom-0" offset="200px" />
				<GridLineVertical className="left-0" offset="80px" />
				<GridLineVertical className="right-0" offset="80px" />
				<div className="bg-card ring-border relative h-full w-full overflow-hidden rounded-lg ring-1 shadow-lg">
					<div className="border-border flex items-center gap-1.5 border-b px-2 py-1.5">
						<span className="size-1.5 rounded-full bg-red-400" />
						<span className="size-1.5 rounded-full bg-amber-400" />
						<span className="size-1.5 rounded-full bg-primary" />
						<span className="text-muted-foreground ml-1 font-mono text-[6px]">
							checkout.local/receipt
						</span>
					</div>
					<div className="p-3">
						<div className="bg-foreground/5 h-2 w-1/2 rounded" />
						<div className="border-border mt-3 rounded-lg border p-2">
							<IconDeviceDesktop className="text-muted-foreground size-4" />
							<div className="bg-foreground/5 mt-2 h-1.5 w-full rounded" />
							<div className="bg-foreground/5 mt-1.5 h-1.5 w-3/4 rounded" />
						</div>
						<div className="bg-primary/15 text-primary mt-3 flex items-center justify-center gap-1 rounded-md py-1.5 font-mono text-[7px]">
							<IconCheck className="size-3" /> receipt visible
						</div>
					</div>
					<motion.div
						initial={{ x: "-110%" }}
						animate={{ x: reduceMotion ? "110%" : "110%" }}
						transition={{
							duration: reduceMotion ? 0 : 1.8,
							repeat: reduceMotion ? 0 : Infinity,
							repeatDelay: 1.2,
							ease: "easeInOut",
						}}
						className="absolute inset-y-0 w-px bg-linear-to-b from-transparent via-primary to-transparent shadow-[0_0_18px_var(--color-primary)]"
					/>
					<span className="text-primary absolute right-2 bottom-2 flex items-center gap-1 font-mono text-[7px]">
						<IconPhoto className="size-3" /> trace captured
					</span>
				</div>
			</div>
		</div>
	);
}
