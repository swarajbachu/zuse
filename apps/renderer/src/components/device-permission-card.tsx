import type { DeviceCommand, PermissionDecision } from "@zuse/contracts";
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
	return (
		<PermissionPrompt
			requestId={command.id}
			kind={{ _tag: "Bash", command: command.command }}
			queueSize={queueSize}
			onDecision={onDecision}
			headline={
				<span className="inline-flex items-center gap-1.5">
					<Laptop className="size-3.5" />
					Run command on {command.deviceName}?
				</span>
			}
			context={
				<div className="mt-1 text-[11px] text-muted-foreground">
					<div className="break-all font-mono">{command.cwd}</div>
					<div>
						Shell access can read and change local files. Saved approvals apply
						to this computer.
					</div>
				</div>
			}
		/>
	);
}
