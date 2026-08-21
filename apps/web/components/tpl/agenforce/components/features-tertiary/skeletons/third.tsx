import {
	IconCheck,
	IconFileCode,
	IconGitBranch,
	IconUpload,
} from "@tabler/icons-react";

const FILES = [
	{ name: "auth/session.ts", stat: "+18 −4" },
	{ name: "auth/recovery.ts", stat: "+31 −0" },
	{ name: "auth.test.ts", stat: "+22 −2" },
] as const;

export const SkeletonThree = () => (
	<div className="border-border bg-elevated absolute inset-x-4 top-0 mx-auto max-w-md overflow-hidden rounded-t-2xl border shadow-lg shadow-black/5">
		<div className="border-border bg-card flex items-center justify-between border-b px-4 py-3">
			<div className="flex min-w-0 items-center gap-2">
				<IconGitBranch className="text-primary size-4 shrink-0" />
				<span className="text-heading truncate font-mono text-[10px]">
					agent/checkout-recovery
				</span>
			</div>
			<span className="text-muted-foreground font-mono text-[9px]">
				3 selected
			</span>
		</div>
		<div className="space-y-1 p-2">
			{FILES.map((file) => (
				<div
					key={file.name}
					className="bg-card flex items-center gap-2 rounded-lg px-3 py-2.5"
				>
					<span className="border-primary bg-primary text-primary-foreground grid size-4 place-items-center rounded">
						<IconCheck className="size-2.5" />
					</span>
					<IconFileCode className="text-muted-foreground size-3.5" />
					<span className="text-heading min-w-0 flex-1 truncate font-mono text-[9px]">
						{file.name}
					</span>
					<span className="text-primary font-mono text-[8px]">{file.stat}</span>
				</div>
			))}
		</div>
		<div className="border-border bg-card border-t p-3">
			<div className="border-border bg-background rounded-lg border px-3 py-2 text-[10px] text-heading">
				fix: recover expired checkout sessions
			</div>
			<div className="mt-2 flex items-center gap-2">
				<div className="bg-heading text-background flex min-h-9 flex-1 items-center justify-center rounded-lg text-[10px] font-medium">
					Commit 3 files
				</div>
				<div className="border-border text-muted-foreground flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-[10px]">
					<IconUpload className="size-3.5" /> Push
				</div>
			</div>
		</div>
	</div>
);
