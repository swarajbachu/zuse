"use client";

import {
	IconArrowFork,
	IconCheck,
	IconMessage,
	IconPaperclip,
} from "@tabler/icons-react";
import Image from "next/image";

export const SkeletonTwo = () => (
	<div className="relative mx-auto flex h-full w-full max-w-lg items-center justify-center overflow-hidden px-5">
		<div className="bg-primary/10 absolute h-48 w-48 rounded-full blur-3xl" />
		<div className="relative w-full max-w-sm">
			<div className="border-border bg-card rounded-2xl border p-3 shadow-xl">
				<div className="flex items-center gap-2">
					<span className="grid size-8 place-items-center rounded-lg bg-white ring-1 ring-black/10">
						<Image src="/logos/claude.svg" alt="" width={17} height={17} />
					</span>
					<div>
						<p className="text-heading text-[10px] font-semibold">
							Continue this work
						</p>
						<p className="text-muted-foreground text-[8px]">
							Choose a provider and context
						</p>
					</div>
					<IconArrowFork className="text-primary ml-auto size-4" />
				</div>
				<div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
					<div className="border-primary/25 bg-primary/5 flex items-center gap-2 rounded-xl border p-2.5">
						<Image
							src="/logos/openai.svg"
							alt=""
							width={16}
							height={16}
							className="rounded bg-white p-0.5"
						/>
						<div>
							<p className="text-heading text-[9px] font-medium">
								New Codex session
							</p>
							<p className="text-muted-foreground text-[7px]">Fork from here</p>
						</div>
						<IconCheck className="text-primary ml-auto size-3" />
					</div>
					<div className="border-border grid size-11 place-items-center rounded-xl border">
						<IconArrowFork className="text-muted-foreground size-4" />
					</div>
				</div>
			</div>
			<div className="border-primary/25 bg-background relative z-10 -mt-2 mx-5 grid grid-cols-2 divide-x rounded-xl border shadow-lg">
				<div className="flex items-center gap-2 p-2.5">
					<IconMessage className="text-primary size-3.5" />
					<div>
						<p className="text-heading text-[8px] font-medium">Transcript</p>
						<p className="text-muted-foreground text-[7px]">Copied</p>
					</div>
				</div>
				<div className="flex items-center gap-2 p-2.5">
					<IconPaperclip className="text-primary size-3.5" />
					<div>
						<p className="text-heading text-[8px] font-medium">Files</p>
						<p className="text-muted-foreground text-[7px]">Select to attach</p>
					</div>
				</div>
			</div>
		</div>
	</div>
);
