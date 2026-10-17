import { EnvironmentId, type SimulatorState } from "@zuse/contracts";
import { useEffect, useRef } from "react";
import { getLocalEnvironmentId } from "~/lib/rpc-client.ts";
import {
	useSimulatorActions,
	useSimulatorState,
} from "~/lib/simulator-client-bus.ts";
import {
	requirementSections,
	requirementsBlocked,
	simulatorSummary,
} from "~/lib/simulator-view.ts";
import {
	type RequirementFix,
	RequirementRow,
	RequirementSectionLabel,
	RequirementsChecking,
	useRequirementFix,
} from "../simulator/simulator-parts.tsx";
import { Button } from "../ui/button.tsx";
import {
	SettingsGroup,
	SettingsNote,
	SettingsRow,
} from "../ui/settings-panel.tsx";
import { Spinner } from "../ui/spinner.tsx";
import { Switch } from "../ui/switch.tsx";

/** Simulator host settings for this computer's environment. */
export function SimulatorSettingsPane() {
	const environmentId = EnvironmentId.make(getLocalEnvironmentId());
	const view = useSimulatorState(environmentId);
	const actions = useSimulatorActions(environmentId);
	const state = view.data;
	const fix = useRequirementFix(actions, state?.requirements ?? []);
	const checked = useRef(false);
	useEffect(() => {
		if (checked.current || !state || state.requirements.length > 0) return;
		checked.current = true;
		void actions.run("simulators.refresh", {}, "check");
	}, [state, actions.run]);
	if (!state)
		return (
			<SettingsGroup title="Simulators">
				<SettingsNote>
					{view.sync === "failed" ? (
						"This computer’s simulator service is unavailable."
					) : (
						<>
							<Spinner className="size-3" /> Loading…
						</>
					)}
				</SettingsNote>
			</SettingsGroup>
		);
	const blocked = !state.enabled && requirementsBlocked(state);
	const configure = (patch: Record<string, boolean>, label: string) =>
		void actions.run(
			"simulators.configure",
			{ ...patch, onboardingCompleted: true },
			label,
		);
	return (
		<div className="flex flex-col gap-4">
			<SettingsGroup
				title="Simulators"
				description="Preview apps on iOS simulators and Android emulators in a chat’s side panel. Devices run on this computer; each chat opens its own."
			>
				<SettingsRow
					title="Simulators"
					description={simulatorSummary(state)}
					action={
						<Switch
							aria-label="Simulators"
							checked={state.enabled}
							disabled={blocked || actions.pending !== null}
							onCheckedChange={(enabled) => configure({ enabled }, "enabled")}
						/>
					}
				/>
				<SettingsRow
					title="Agent access"
					description="Agents can open devices, tap, type and take screenshots to check their work. Turn off to keep controls manual."
					action={
						<Switch
							aria-label="Agent access"
							checked={state.agentAccessEnabled}
							disabled={!state.enabled || actions.pending !== null}
							onCheckedChange={(agentAccessEnabled) =>
								configure({ agentAccessEnabled }, "agents")
							}
						/>
					}
				/>
				{state.agentAccessEnabled && state.agentDetail ? (
					<SettingsNote
						tone={state.agentStatus === "error" ? "error" : "muted"}
					>
						{state.agentStatus === "installing" ? (
							<Spinner className="size-3" />
						) : null}
						{state.agentDetail}
					</SettingsNote>
				) : null}
				{actions.error ? (
					<SettingsNote tone="error">{actions.error}</SettingsNote>
				) : null}
			</SettingsGroup>
			<SettingsGroup
				title="Requirements"
				description="Checked on this computer. Fixes run only when you choose them."
				action={
					<Button
						size="sm"
						variant="settings"
						loading={actions.pending === "check"}
						onClick={() => void actions.run("simulators.refresh", {}, "check")}
					>
						Check again
					</Button>
				}
			>
				<RequirementRows state={state} fix={fix} />
			</SettingsGroup>
			<SettingsGroup
				title="Tools"
				footer="Downloaded on first use at pinned versions into Zuse’s data folder, separately from your projects."
			>
				<SettingsRow
					title="Device hub"
					description={`expo-device-hub ${state.tools.hub} · streams iOS and Android screens and sends touch and keyboard input`}
					action={<ToolStatus label={hubStatus(state)} />}
				/>
				<SettingsRow
					title="Agent tools"
					description={`agent-device ${state.tools.agent} · lets agents read and operate the app`}
					action={<ToolStatus label={agentStatus(state)} />}
				/>
			</SettingsGroup>
		</div>
	);
}

function RequirementRows({
	state,
	fix,
}: {
	state: SimulatorState;
	fix: RequirementFix;
}) {
	if (state.requirements.length === 0)
		return <RequirementsChecking className="px-3" />;
	const sections = requirementSections(state.requirements);
	return sections.map((section) => (
		<div key={section.platform} className="flex flex-col px-3 py-2">
			{sections.length > 1 ? (
				<RequirementSectionLabel platform={section.platform} className="pb-1" />
			) : null}
			{section.items.map((item) => (
				<RequirementRow key={item.id} item={item} fix={fix} className="py-1" />
			))}
		</div>
	));
}

function ToolStatus({ label }: { label: string }) {
	return <span className="text-[11px] text-muted-foreground">{label}</span>;
}

function hubStatus(state: SimulatorState) {
	switch (state.status) {
		case "disabled":
			return "Off";
		case "idle":
			return "Starts on demand";
		case "checking":
			return "Checking…";
		case "installing":
			return "Installing…";
		case "starting":
			return "Starting…";
		case "ready":
			return "Running";
		default:
			return "Stopped";
	}
}

function agentStatus(state: SimulatorState) {
	if (!state.enabled || !state.agentAccessEnabled) return "Off";
	switch (state.agentStatus) {
		case "installing":
			return "Installing…";
		case "ready":
			return "Ready";
		case "error":
			return "Failed";
		default:
			return "Installs on first use";
	}
}
