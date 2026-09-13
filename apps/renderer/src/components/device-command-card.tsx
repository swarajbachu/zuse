import { DEVICE_PERMISSION_CHOICES } from "@zuse/client-runtime/device-permission-presentation";
import type { DeviceBridgeAction, DeviceCommand } from "@zuse/contracts";
import { Laptop, Terminal } from "lucide-react";
import { Button } from "./ui/button.tsx";

export function DeviceCommandCard({
	command,
	busy,
	onAction,
	showOutput = true,
}: {
	command: DeviceCommand;
	busy: boolean;
	showOutput?: boolean;
	onAction: (action: DeviceBridgeAction) => Promise<void>;
}) {
	return (
		<div className="space-y-2 py-1 text-xs">
			<div className="flex h-7 items-center gap-2 font-medium">
				<Laptop
					aria-label="Local computer"
					className="size-3.5 shrink-0 text-muted-foreground"
				/>
				<Terminal
					aria-hidden="true"
					className="size-3.5 shrink-0 text-muted-foreground"
				/>
				{command.deviceName} · {command.state}
			</div>
			<div className="text-muted-foreground">{command.chatTitle}</div>
			<div className="break-all font-mono">{command.cwd}</div>
			<pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all font-mono">
				{command.command}
			</pre>
			{command.state === "pending" && (
				<div className="flex flex-wrap gap-1">
					{DEVICE_PERMISSION_CHOICES.map(([decision, label]) => (
						<Button
							key={decision}
							className="h-7"
							disabled={busy}
							onClick={() =>
								void onAction({ _tag: "decide", id: command.id, decision })
							}
						>
							{label}
						</Button>
					))}
				</div>
			)}
			{command.state === "running" && (
				<Button
					className="h-7"
					disabled={busy}
					onClick={() => void onAction({ _tag: "cancel", id: command.id })}
				>
					Stop command
				</Button>
			)}
			{showOutput && (command.stdout || command.stderr) && (
				<details>
					<summary>
						Output
						{command.exitCode !== null ? ` · Exit ${command.exitCode}` : ""}
						{command.truncated ? " · Truncated" : ""}
					</summary>
					<pre className="max-h-40 overflow-auto whitespace-pre-wrap">
						{command.stdout}
						{command.stderr}
					</pre>
				</details>
			)}
		</div>
	);
}
