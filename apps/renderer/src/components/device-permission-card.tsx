import "@zuse/i18n/english/chat";
import type { DeviceCommand, PermissionDecision } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Laptop } from "lucide-react";
import { PermissionPrompt } from "./permission-card.tsx";

export function DevicePermissionCard({
	command,
	queueSize,
	onDecision,
}: {
	command: DeviceCommand;
	queueSize: number;
	onDecision: (id: string, decision: PermissionDecision) => Promise<void>;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);

	return (
		<PermissionPrompt
			requestId={command.id}
			kind={{ _tag: "Bash", command: command.command }}
			queueSize={queueSize}
			onDecision={onDecision}
			headline={
				<span className="inline-flex items-center gap-1.5">
					<Laptop className="size-3.5" />
					{uiMessage("chat:device_permission_card_run_command_on", {
						device: command.deviceName,
					})}
				</span>
			}
			context={
				<div className="mt-1 text-[11px] text-muted-foreground">
					<div className="break-all font-mono">{command.cwd}</div>
					<div>
						{uiMessage(
							"chat:device_permission_card_shell_access_can_read_and_change_local_files_saved_approvals_apply_to_this_computer",
						)}
					</div>
				</div>
			}
		/>
	);
}
