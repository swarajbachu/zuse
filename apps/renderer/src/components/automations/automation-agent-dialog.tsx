import { FolderId } from "@zuse/contracts";
import { useId, useRef, useState } from "react";
import { launchAutomationAgent } from "~/lib/automation-agent.ts";
import { useAutomationMessages } from "~/lib/automation-messages.ts";
import { useActiveEnvironmentEntities } from "~/lib/environment-entity-hooks.ts";
import { formatError } from "~/lib/format-error.ts";
import { PROVIDER_LABEL } from "~/lib/provider-labels.ts";
import { useSettingsStore } from "~/lib/settings-client-bus.ts";
import { useWorkspaceStore } from "~/store/workspace.ts";
import { ProviderIcon } from "../provider-icons.tsx";
import { Button } from "../ui/button.tsx";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "../ui/dialog.tsx";
import { Textarea } from "../ui/textarea.tsx";
import {
	AutomationNotice,
	AutomationRow,
	AutomationSelect,
} from "./automation-controls.tsx";

export type AutomationAgentIntent = "generate" | "suggest";

const EXAMPLES = [
	"Every weekday at 9, summarize open pull requests that need review.",
	"When a check run fails on main, investigate and propose a fix.",
	"When someone mentions the bot in Slack, triage the report in the thread.",
];

export function AutomationAgentDialog({
	intent,
	projectId,
	onClose,
}: {
	intent: AutomationAgentIntent;
	projectId: FolderId | null;
	onClose: () => void;
}) {
	const automationMessage = useAutomationMessages();

	const id = useId();
	const { folders } = useActiveEnvironmentEntities();
	const providerId = useSettingsStore((state) => state.defaultProviderId);
	const [description, setDescription] = useState("");
	const [starting, setStarting] = useState(false);
	const pending = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const suggest = intent === "suggest";
	const start = () => {
		if (!projectId || pending.current) return;
		pending.current = true;
		setStarting(true);
		setError(null);
		void launchAutomationAgent(projectId, intent, description)
			.then(onClose, (cause) => setError(formatError(cause)))
			.finally(() => {
				pending.current = false;
				setStarting(false);
			});
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !starting) onClose();
			}}
		>
			<DialogPopup className="max-w-md">
				<DialogHeader>
					<DialogTitle>
						{suggest
							? automationMessage("automations:suggest_automations")
							: automationMessage("automations:describe_an_automation")}
					</DialogTitle>
					<DialogDescription>
						{suggest
							? automationMessage(
									"automations:an_agent_looks_at_recent_work_and_proposes_automations",
								)
							: automationMessage(
									"automations:an_agent_sets_it_up_and_saves_it_as_a_draft_for_you_to_review",
								)}
					</DialogDescription>
				</DialogHeader>
				<DialogPanel className="space-y-3 text-xs">
					<Textarea
						id={`${id}-request`}
						aria-label={
							suggest
								? automationMessage("automations:focus")
								: automationMessage("automations:automation_request")
						}
						className="min-h-24 text-xs"
						placeholder={
							suggest
								? automationMessage("automations:anything_to_focus_on_optional")
								: automationMessage(
										"automations:every_weekday_at_9_summarize_open_pull_requests",
									)
						}
						value={description}
						onChange={(event) => setDescription(event.target.value)}
						onKeyDown={(event) => {
							if (
								event.key === "Enter" &&
								(event.metaKey || event.ctrlKey) &&
								(suggest || description.trim())
							)
								start();
						}}
					/>
					{!suggest && !description.trim() && (
						<ul className="space-y-0.5">
							{EXAMPLES.map((example) => (
								<li key={example}>
									<button
										type="button"
										className="-mx-1.5 w-[calc(100%+0.75rem)] truncate rounded-md px-1.5 py-1 text-left text-muted-foreground outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
										onClick={() => setDescription(example)}
									>
										{example}
									</button>
								</li>
							))}
						</ul>
					)}
					{folders.length > 1 && (
						<AutomationRow
							label={automationMessage("automations:project")}
							htmlFor={`${id}-project`}
						>
							<AutomationSelect
								id={`${id}-project`}
								label={automationMessage("automations:project")}
								value={projectId ?? ""}
								options={folders.map((folder) => ({
									value: folder.id as string,
									label: folder.name,
								}))}
								onChange={(value) =>
									void useWorkspaceStore.getState().select(FolderId.make(value))
								}
							/>
						</AutomationRow>
					)}
					{error && <AutomationNotice tone="error">{error}</AutomationNotice>}
				</DialogPanel>
				<DialogFooter className="items-center sm:justify-between">
					<p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
						<ProviderIcon providerId={providerId} className="size-3" />
						{automationMessage("automations:opens_provider_session", {
							provider: PROVIDER_LABEL[providerId] ?? providerId,
						})}
					</p>
					<div className="flex gap-1.5">
						<Button
							className="h-7"
							variant="ghost"
							disabled={starting}
							onClick={onClose}
						>
							{automationMessage("automations:cancel")}
						</Button>
						<Button
							className="h-7"
							loading={starting}
							disabled={!projectId || (!suggest && !description.trim())}
							onClick={start}
						>
							{automationMessage("automations:start")}
						</Button>
					</div>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}
