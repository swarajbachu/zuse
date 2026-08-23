import { HugeiconsIcon } from "@hugeicons/react";
import type { RuntimeMode, SessionId } from "@zuse/contracts";
import { ArrowDown01Icon } from "@zuse/icons/solid-rounded";

import { useSessionsStore } from "../store/sessions.ts";
import { MODE_META, runtimeModesForProvider } from "./runtime-mode-meta.ts";
import {
	Menu,
	MenuGroup,
	MenuGroupLabel,
	MenuPopup,
	MenuRadioGroup,
	MenuRadioItem,
	MenuTrigger,
} from "./ui/menu.tsx";

const CODEX_MODES = runtimeModesForProvider("codex");

const isVisibleRuntimeMode = (value: string): value is RuntimeMode =>
	CODEX_MODES.includes(value as RuntimeMode);

export function PermissionPresetMenu({
	sessionId,
	current,
}: {
	readonly sessionId: SessionId;
	readonly current: RuntimeMode;
}) {
	const setRuntimeMode = useSessionsStore((state) => state.setRuntimeMode);
	const selected = MODE_META[current];

	return (
		<Menu>
			<MenuTrigger
				aria-label={`Permission mode: ${selected.label}`}
				className="flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none"
			>
				<HugeiconsIcon icon={selected.Icon} className="size-3.5" />
				<span>{selected.label}</span>
				<HugeiconsIcon icon={ArrowDown01Icon} className="size-3 opacity-60" />
			</MenuTrigger>
			<MenuPopup align="start" side="top" className="w-80">
				<MenuGroup>
					<MenuGroupLabel>How should actions be approved?</MenuGroupLabel>
					<MenuRadioGroup
						value={current}
						onValueChange={(value) => {
							if (!isVisibleRuntimeMode(value) || value === current) return;
							void setRuntimeMode(sessionId, value);
						}}
					>
						{CODEX_MODES.map((mode) => {
							const option = MODE_META[mode];
							return (
								<MenuRadioItem
									key={mode}
									value={mode}
									className="items-start py-2"
								>
									<HugeiconsIcon
										icon={option.Icon}
										className="mt-0.5 size-4 shrink-0 text-muted-foreground"
									/>
									<span className="flex min-w-0 flex-col gap-0.5">
										<span className="font-medium">{option.label}</span>
										<span className="text-[11px] leading-snug text-muted-foreground">
											{option.description}
										</span>
									</span>
								</MenuRadioItem>
							);
						})}
					</MenuRadioGroup>
				</MenuGroup>
			</MenuPopup>
		</Menu>
	);
}
