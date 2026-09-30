import "@zuse/i18n/english/chat";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ProviderId, RuntimeMode } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { ChevronDown } from "lucide-react";
import { cn } from "~/lib/utils";
import { MODE_META, MODES_ORDER } from "./runtime-mode-meta.ts";
import {
	Menu,
	MenuPopup,
	MenuRadioGroup,
	MenuRadioItem,
	MenuTrigger,
} from "./ui/menu.tsx";

export function RuntimeAccessPicker({
	onChange,
	providerId,
	current,
	pending,
	confirmed,
}: {
	onChange: (mode: RuntimeMode) => void;
	providerId: ProviderId;
	current: RuntimeMode;
	pending: boolean;
	confirmed: boolean;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	const meta = MODE_META[current];
	if (providerId === "pi")
		return (
			<span className="text-xs text-muted-foreground">
				{uiMessage("chat:pi_permissions")}
			</span>
		);
	const fixedSandbox = providerId === "cursor";
	const highlighted = confirmed && current === "full-access";

	return (
		<Menu>
			<MenuTrigger
				disabled={fixedSandbox || pending}
				aria-label={
					fixedSandbox
						? uiMessage("chat:chat_composer_cursor_uses_fixed_sandbox_access")
						: uiMessage("chat:chat_composer_agent_access")
				}
				className={cn(
					"flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors hover:bg-muted/60 data-[popup-open]:bg-muted/70 disabled:cursor-default disabled:opacity-60",
					highlighted
						? "text-warning"
						: "text-muted-foreground hover:text-foreground",
				)}
			>
				<HugeiconsIcon icon={meta.Icon} className="size-3.5" />
				<span>
					{fixedSandbox
						? uiMessage("chat:chat_composer_sandboxed")
						: confirmed
							? meta.label
							: uiMessage("chat:chat_composer_checking_access")}
				</span>
				{pending ? (
					<span role="status" aria-live="polite">
						{uiMessage("chat:chat_composer_updating")}
					</span>
				) : null}
				{fixedSandbox ? null : <ChevronDown className="size-3 opacity-60" />}
			</MenuTrigger>
			<MenuPopup side="top" align="start" className="w-64 p-1">
				<div className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
					{uiMessage("chat:chat_composer_agent_access")}
				</div>
				<MenuRadioGroup
					value={current}
					onValueChange={(value) => onChange(value as RuntimeMode)}
				>
					{(MODES_ORDER.includes(current)
						? MODES_ORDER
						: [current, ...MODES_ORDER]
					).map((mode) => {
						const option = MODE_META[mode];
						return (
							<MenuRadioItem
								key={mode}
								value={mode}
								disabled={
									mode === "auto" &&
									providerId !== "codex" &&
									providerId !== "claude" &&
									providerId !== "grok"
								}
								className="px-2 py-2 text-xs"
							>
								<span className="flex min-w-0 flex-col gap-1">
									<span className="flex items-center gap-2 font-medium text-foreground">
										<HugeiconsIcon icon={option.Icon} className="size-3.5" />
										{option.label}
									</span>
									<span className="text-[11px] font-normal leading-4 text-muted-foreground">
										{option.description}
									</span>
								</span>
							</MenuRadioItem>
						);
					})}
				</MenuRadioGroup>
				<p className="px-2 py-1.5 text-[10px] leading-4 text-muted-foreground">
					{uiMessage("chat:runtime_mode_change_stops_turn")}
				</p>
			</MenuPopup>
		</Menu>
	);
}
