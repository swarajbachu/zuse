import { HugeiconsIcon } from "@hugeicons/react";
import { Tick01Icon } from "@hugeicons-pro/core-stroke-rounded";
import { MODE_META, MODES_ORDER } from "~/components/runtime-mode-meta";
import { ModelSelect } from "~/components/settings-page";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";
import { useSettingsStore } from "../../../store/settings.ts";
import { StepHeader } from "./shared.tsx";

export function DefaultsStep() {
	const defaultProviderId = useSettingsStore((s) => s.defaultProviderId);
	const defaultModelByProvider = useSettingsStore(
		(s) => s.defaultModelByProvider,
	);
	const setDefaultModel = useSettingsStore((s) => s.setDefaultModel);
	const defaultRuntimeMode = useSettingsStore((s) => s.defaultRuntimeMode);
	const setDefaultRuntimeMode = useSettingsStore(
		(s) => s.setDefaultRuntimeMode,
	);
	const defaultAutoCreateWorktree = useSettingsStore(
		(s) => s.defaultAutoCreateWorktree,
	);
	const setDefaultAutoCreateWorktree = useSettingsStore(
		(s) => s.setDefaultAutoCreateWorktree,
	);

	return (
		<div className="flex flex-col gap-7">
			<StepHeader
				title="A few quick defaults"
				subtitle="Tweak any of these later in Settings. Per-chat overrides always win."
			/>

			<div className="flex flex-col gap-5">
				<FieldRow label="Default model">
					<ModelSelect
						providerId={defaultProviderId}
						value={defaultModelByProvider[defaultProviderId]}
						onChange={(model) => setDefaultModel(defaultProviderId, model)}
					/>
				</FieldRow>

				<div className="flex flex-col gap-2.5">
					<span className="text-[12px] font-medium text-foreground">
						Permission mode
					</span>
					<div className="flex flex-col gap-1.5">
						{MODES_ORDER.map((mode) => {
							const m = MODE_META[mode];
							const active = mode === defaultRuntimeMode;
							return (
								<button
									key={mode}
									type="button"
									aria-pressed={active}
									onClick={() => setDefaultRuntimeMode(mode)}
									className={cn(
										"group flex items-center gap-3 rounded-2xl px-3.5 py-2.5 text-left transition-all",
										active
											? "bg-accent text-accent-foreground"
											: "bg-muted/60 hover:bg-muted",
									)}
								>
									<span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-background/70 text-foreground">
										<HugeiconsIcon
											icon={m.Icon}
											className="size-3.5"
											strokeWidth={1.75}
										/>
									</span>
									<span className="flex min-w-0 flex-1 flex-col gap-0.5">
										<span className="text-[13px] font-medium leading-none text-foreground">
											{m.label}
										</span>
										<span className="text-[11px] leading-snug text-muted-foreground">
											{m.description}
										</span>
									</span>
									{active && (
										<span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
											<HugeiconsIcon
												icon={Tick01Icon}
												className="size-2.5"
												strokeWidth={3.5}
											/>
										</span>
									)}
								</button>
							);
						})}
					</div>
				</div>

				<label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-muted/60 px-3.5 py-3 transition-colors hover:bg-muted">
					<span className="flex min-w-0 flex-1 flex-col gap-1">
						<span className="flex items-center gap-2">
							<span className="text-[13px] font-medium leading-none text-foreground">
								New worktree per chat
							</span>
							<span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-primary">
								Recommended
							</span>
						</span>
						<span className="text-[11px] leading-snug text-muted-foreground">
							A git worktree is a second checkout of your repo on its own
							branch. Each chat gets one under <code>~/.zuse/</code>, so agents
							can run in parallel without stepping on each other or your working
							tree. You merge the branches you like.
						</span>
					</span>
					<Switch
						checked={defaultAutoCreateWorktree}
						onCheckedChange={setDefaultAutoCreateWorktree}
					/>
				</label>
			</div>
		</div>
	);
}

function FieldRow({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-2">
			<span className="text-[12px] font-medium text-foreground">{label}</span>
			{children}
		</div>
	);
}
