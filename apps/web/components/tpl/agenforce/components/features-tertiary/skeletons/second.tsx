"use client";

import { IconFileDiff, IconMessageCircle } from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/components/tpl/agenforce/lib/utils";

const TILES = [
	"auth.ts",
	"+ guard retry",
	"- stale state",
	"test.ts",
	"+ regression",
	"16 passed",
	"review",
	"2 comments",
	"resolved",
];

export const SkeletonTwo = () => {
	const reduceMotion = useReducedMotion();
	return (
		<div className="flex h-full w-full flex-1 flex-col items-center justify-center gap-3 px-8">
			<div className="grid w-full max-w-md grid-cols-4 gap-2">
				{TILES.slice(0, 4).map((tile, index) => (
					<DiffTile
						key={tile}
						tile={tile}
						index={index}
						reduceMotion={reduceMotion}
					/>
				))}
			</div>
			<div className="grid w-full max-w-lg grid-cols-5 gap-2">
				{TILES.slice(4).map((tile, index) => (
					<DiffTile
						key={tile}
						tile={tile}
						index={index + 4}
						reduceMotion={reduceMotion}
					/>
				))}
			</div>
			<div className="border-border bg-card flex w-full max-w-sm items-start gap-2 rounded-xl border p-3 shadow-xl">
				<IconMessageCircle className="text-primary mt-0.5 size-4 shrink-0" />
				<p className="text-muted-foreground text-[10px] leading-4">
					<span className="text-heading font-medium">Codex review:</span> Retry
					only after the persisted checkout state is restored.
				</p>
			</div>
		</div>
	);
};

function DiffTile({
	tile,
	index,
	reduceMotion,
}: {
	tile: string;
	index: number;
	reduceMotion: boolean | null;
}) {
	const positive =
		tile.startsWith("+") || tile.includes("passed") || tile === "resolved";
	const negative = tile.startsWith("-");
	return (
		<div className="border-border relative aspect-square rounded-xl border border-dashed p-px">
			<motion.div
				initial={false}
				whileInView={{ opacity: 1, scale: 1 }}
				transition={{ duration: 0.24, delay: reduceMotion ? 0 : index * 0.045 }}
				className={cn(
					"bg-card relative z-10 flex h-full w-full items-center justify-center rounded-[11px] p-1 text-center font-mono text-[8px] shadow-sm",
					positive && "bg-primary/10 text-primary",
					negative && "bg-red-500/10 text-red-500",
					!positive && !negative && "text-muted-foreground",
				)}
			>
				{index === 0 ? <IconFileDiff className="size-4" /> : tile}
			</motion.div>
			<div className="absolute inset-0 rounded-xl bg-[image:repeating-linear-gradient(315deg,var(--color-border)_0,var(--color-border)_1px,transparent_0,transparent_50%)] bg-[size:5px_5px]" />
		</div>
	);
}
