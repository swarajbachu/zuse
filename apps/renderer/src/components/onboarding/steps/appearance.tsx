import "@zuse/i18n/english/onboarding";
import { HugeiconsIcon } from "@hugeicons/react";
import type { AppearanceMode } from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	ComputerIcon,
	Moon02Icon,
	Sun03Icon,
	Tick01Icon,
} from "@zuse/icons/solid-rounded";

import { cn } from "~/lib/utils";
import { useSettingsStore } from "../../../lib/settings-client-bus.ts";
import { StepHeader } from "./shared.tsx";

const APPEARANCE_OPTIONS: ReadonlyArray<{
	readonly value: AppearanceMode;
	readonly label: string;
	readonly description: string;
	readonly Icon: typeof ComputerIcon;
}> = [
	{
		value: "system",
		get label() {
			return uiMessage("onboarding:appearance_system");
		},
		get description() {
			return uiMessage("onboarding:appearance_match_your_mac_automatically");
		},
		Icon: ComputerIcon,
	},
	{
		value: "light",
		get label() {
			return uiMessage("onboarding:appearance_light");
		},
		get description() {
			return uiMessage("onboarding:appearance_use_the_brighter_interface");
		},
		Icon: Sun03Icon,
	},
	{
		value: "dark",
		get label() {
			return uiMessage("onboarding:appearance_dark");
		},
		get description() {
			return uiMessage("onboarding:appearance_keep_the_classic_dark_interface");
		},
		Icon: Moon02Icon,
	},
];

export function AppearanceStep() {
	const { message: uiMessage } = useUiMessages(["onboarding"]);

	const appearanceMode = useSettingsStore((s) => s.appearanceMode);
	const setAppearanceMode = useSettingsStore((s) => s.setAppearanceMode);

	return (
		<div className="flex flex-col gap-7">
			<StepHeader
				title={uiMessage("onboarding:appearance_choose_your_appearance")}
				subtitle="Pick a starting look. You can change this later in Settings."
			/>

			<div className="grid gap-2">
				{APPEARANCE_OPTIONS.map((option) => {
					const active = option.value === appearanceMode;
					return (
						<button
							key={option.value}
							type="button"
							aria-pressed={active}
							onClick={() => setAppearanceMode(option.value)}
							className={cn(
								"group flex items-center gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors",
								active
									? "border-input bg-accent text-accent-foreground"
									: "border-border bg-card hover:bg-muted",
							)}
						>
							<span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background/70 text-foreground">
								<HugeiconsIcon
									icon={option.Icon}
									className="size-4"
									strokeWidth={1.75}
								/>
							</span>
							<span className="flex min-w-0 flex-1 flex-col gap-1">
								<span className="text-[13px] font-medium leading-none text-foreground">
									{option.label}
								</span>
								<span className="text-[11px] leading-snug text-muted-foreground">
									{option.description}
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
	);
}
