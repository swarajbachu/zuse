"use client";

import {
	IconCheck,
	IconFileDiff,
	IconMessage,
	IconPaperclip,
	IconTestPipe,
} from "@tabler/icons-react";
import Image from "next/image";

export const SkeletonOne = () => (
	<div className="relative mx-auto h-full w-full max-w-lg overflow-hidden px-5 pt-5">
		<div className="bg-primary/10 absolute top-16 left-1/2 h-40 w-52 -translate-x-1/2 rounded-full blur-3xl" />
		<AgentCard
			className="absolute top-5 left-5 -rotate-2"
			logo="/logos/claude.svg"
			label="Planning session"
			title="Claude Code"
			footer="Plan complete"
		/>
		<AgentCard
			className="absolute right-5 bottom-5 rotate-2"
			logo="/logos/openai.svg"
			label="Implementation session"
			title="Codex"
			footer="Ready to start"
		/>
		<div className="border-primary/30 bg-card absolute top-[42%] left-1/2 z-10 w-44 -translate-x-1/2 rounded-xl border p-2.5 shadow-xl">
			<div className="flex items-center gap-2">
				<IconPaperclip className="text-primary size-3.5" />
				<p className="text-heading text-[9px] font-semibold">Handoff context</p>
				<IconCheck className="text-primary ml-auto size-3" />
			</div>
			<div className="mt-2 grid grid-cols-3 gap-1">
				<Context icon={IconMessage} label="Plan" />
				<Context icon={IconFileDiff} label="Diff" />
				<Context icon={IconTestPipe} label="Tests" />
			</div>
		</div>
	</div>
);

function AgentCard({
	className,
	logo,
	label,
	title,
	footer,
}: {
	className: string;
	logo: string;
	label: string;
	title: string;
	footer: string;
}) {
	return (
		<div
			className={`border-border bg-card w-[58%] rounded-2xl border p-3 shadow-xl ${className}`}
		>
			<div className="flex items-center gap-2">
				<span className="grid size-8 place-items-center rounded-lg bg-white ring-1 ring-black/10">
					<Image src={logo} alt="" width={17} height={17} />
				</span>
				<div>
					<p className="text-muted-foreground text-[7px] uppercase">{label}</p>
					<p className="text-heading text-[10px] font-semibold">{title}</p>
				</div>
			</div>
			<div className="border-border mt-3 space-y-1.5 border-y py-2">
				<span className="bg-muted block h-1.5 w-full rounded-full" />
				<span className="bg-muted block h-1.5 w-4/5 rounded-full" />
				<span className="bg-primary/30 block h-1.5 w-3/5 rounded-full" />
			</div>
			<p className="text-primary mt-2 text-[8px] font-medium">{footer}</p>
		</div>
	);
}

function Context({
	icon: Icon,
	label,
}: {
	icon: typeof IconMessage;
	label: string;
}) {
	return (
		<div className="bg-elevated flex flex-col items-center gap-1 rounded-md py-1.5">
			<Icon className="text-primary size-3" />
			<span className="text-muted-foreground text-[7px]">{label}</span>
		</div>
	);
}
