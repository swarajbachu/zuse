import {
	IconCheck,
	IconGitBranch,
	IconRobot,
	IconX,
} from "@tabler/icons-react";

export const SkeletonFour = () => (
	<div className="relative mx-auto h-full w-full max-w-lg overflow-hidden px-5 pt-4">
		<div className="bg-primary/10 absolute top-14 left-1/2 h-40 w-40 -translate-x-1/2 rounded-full blur-3xl" />
		<div className="border-border bg-card absolute top-5 left-5 w-[72%] -rotate-2 overflow-hidden rounded-2xl border shadow-xl shadow-black/10">
			<div className="border-border flex items-center gap-2 border-b px-3 py-2.5">
				<span className="bg-destructive/15 grid size-6 place-items-center rounded-md">
					<IconX className="text-destructive size-3.5" />
				</span>
				<div className="min-w-0">
					<p className="text-heading text-[10px] font-semibold">checkout-e2e</p>
					<p className="text-muted-foreground font-mono text-[8px]">
						GitHub Actions · failed
					</p>
				</div>
				<span className="text-destructive ml-auto font-mono text-[8px]">
					exit 1
				</span>
			</div>
			<div className="bg-neutral-950 px-3 py-3 font-mono text-[8px] leading-4 text-neutral-400">
				<p>
					<span className="text-red-400">FAIL</span> tests/auth-recovery.spec.ts
				</p>
				<p className="text-neutral-200">Expected redirect to /dashboard</p>
				<p>Received /login?expired=true</p>
				<p className="mt-1 text-lime-400">36 log lines collected</p>
			</div>
		</div>

		<div className="border-primary/25 bg-card absolute right-4 bottom-4 w-[72%] rotate-1 overflow-hidden rounded-2xl border shadow-2xl shadow-black/15">
			<div className="border-border flex items-center gap-2 border-b px-3 py-2.5">
				<span className="bg-primary/15 grid size-7 place-items-center rounded-lg">
					<IconRobot className="text-primary size-4" />
				</span>
				<div>
					<p className="text-heading text-[10px] font-semibold">Agent thread</p>
					<p className="text-muted-foreground font-mono text-[8px]">
						agent/fix-auth
					</p>
				</div>
				<IconGitBranch className="text-muted-foreground ml-auto size-4" />
			</div>
			<div className="p-3">
				<div className="border-border bg-elevated rounded-xl border p-2.5">
					<p className="text-heading text-[9px] font-medium">
						Failed check attached
					</p>
					<p className="text-muted-foreground mt-1 truncate font-mono text-[8px]">
						failing-checks-0821.txt · 36 lines
					</p>
				</div>
				<div className="mt-2 flex items-center gap-2 px-1">
					<span className="bg-primary size-1.5 rounded-full" />
					<p className="text-muted-foreground text-[9px]">
						Diagnosing session redirect…
					</p>
				</div>
			</div>
		</div>

		<div className="border-primary/30 bg-background absolute top-[46%] left-[46%] z-10 grid size-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border shadow-lg">
			<IconCheck className="text-primary size-5" />
		</div>
	</div>
);
