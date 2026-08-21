import {
	IconCheck,
	IconFileDiff,
	IconGitBranch,
	IconLoader2,
} from "@tabler/icons-react";
import { cn } from "@/components/tpl/agenforce/lib/utils";

const STEPS = [
	["Plan attached", "done"],
	["Transcript attached", "done"],
	["Diff · 12 files", "done"],
	["Tests · 16 passing", "done"],
	["Codex reviewing", "active"],
] as const;

export const SkeletonTwo = () => (
	<div
		style={{ transform: "rotateY(20deg) rotateX(20deg) rotateZ(-20deg)" }}
		className={cn(
			"border-border bg-elevated group mx-auto my-auto flex h-full w-full max-w-[85%] translate-x-10 flex-col rounded-2xl border p-3 shadow-2xl mask-b-from-50% mask-radial-from-50%",
			"[--pattern-fg:var(--color-foreground)]/5",
		)}
	>
		<div className="flex items-center gap-3">
			<IconGitBranch className="text-primary size-4" />
			<div>
				<p className="text-heading text-sm font-medium">
					Claude → Codex handoff
				</p>
				<p className="text-muted-foreground font-mono text-[9px]">
					same worktree · same branch
				</p>
			</div>
		</div>
		<div className="border-border bg-foreground/5 relative mt-4 flex-1 rounded-2xl border">
			<div className="absolute inset-0 rounded-2xl bg-[image:repeating-linear-gradient(315deg,_var(--pattern-fg)_0,_var(--pattern-fg)_1px,_transparent_0,_transparent_50%)] bg-[size:10px_10px]" />
			<div className="bg-card absolute inset-0 h-full w-full -translate-y-2 translate-x-2 rounded-2xl transition-transform duration-300 group-hover:translate-x-0 group-hover:translate-y-0 motion-reduce:transform-none motion-reduce:transition-none">
				{STEPS.map(([label, state], index) => (
					<div key={label}>
						<div className="flex items-center justify-between px-4 py-2">
							<div className="flex items-center gap-2">
								<span
									className={cn(
										"grid size-4 place-items-center rounded-full",
										state === "done" ? "bg-primary" : "bg-amber-400",
									)}
								>
									{state === "done" ? (
										<IconCheck className="size-3 text-black" />
									) : (
										<IconLoader2 className="size-3 animate-spin text-black motion-reduce:animate-none" />
									)}
								</span>
								<p className="text-muted-foreground text-xs font-medium">
									{label}
								</p>
							</div>
							{index === 2 && (
								<IconFileDiff className="text-muted-foreground size-3.5" />
							)}
						</div>
						{index < STEPS.length - 1 && (
							<div className="via-border h-px bg-gradient-to-r from-transparent to-transparent" />
						)}
					</div>
				))}
			</div>
		</div>
	</div>
);
