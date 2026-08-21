import {
	IconArchive,
	IconCheck,
	IconGitBranch,
	IconHistory,
} from "@tabler/icons-react";
import DottedGlowBackground from "@/components/tpl/agenforce/components/ui/dotted-glow-background";

export const SkeletonThree = () => (
	<div className="relative flex h-full w-full items-center justify-center overflow-hidden">
		<DottedGlowBackground
			className="pointer-events-none mask-radial-at-center mask-radial-to-70%"
			opacity={1}
			gap={10}
			radius={1.6}
			colorLightVar="--color-neutral-400"
			glowColorLightVar="--color-lime-500"
			colorDarkVar="--color-neutral-600"
			glowColorDarkVar="--color-lime-400"
			backgroundOpacity={0}
			speedMin={0.3}
			speedMax={1.2}
			speedScale={1}
		/>
		<div className="border-border bg-card relative z-10 w-52 rounded-2xl border p-4 shadow-2xl">
			<div className="mx-auto grid size-14 place-items-center rounded-2xl bg-primary/15 ring-1 ring-primary/30">
				<IconArchive className="text-primary size-7" />
			</div>
			<p className="text-heading mt-3 text-center text-sm font-semibold">
				1.8 GB reclaimed
			</p>
			<div className="mt-3 space-y-2">
				{[
					[IconGitBranch, "Branch preserved"],
					[IconHistory, "Commits + run history kept"],
					[IconCheck, "Worktree removed"],
				].map(([Icon, label]) => (
					<p
						key={label as string}
						className="text-muted-foreground flex items-center gap-2 text-[10px]"
					>
						<Icon className="text-primary size-3.5" /> {label as string}
					</p>
				))}
			</div>
		</div>
	</div>
);
