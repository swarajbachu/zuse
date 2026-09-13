import type { ComputerAwakeMode, ComputerAwakeStatus } from "@zuse/contracts";

export const computerAwakeModeDescription = (
	mode: ComputerAwakeMode,
): string => {
	switch (mode) {
		case "off":
			return "Allows this Mac to sleep normally, even while agents are working.";
		case "auto":
			return "Keeps this Mac awake while a local agent is working or an authenticated remote client is connected.";
		case "always":
			return "Keeps this Mac awake whenever Zuse is open.";
	}
};

export const localRuntimeEnvironmentId = (
	entries: ReadonlyArray<{
		readonly connectionKind: string;
		readonly environmentId: string;
	}>,
	activeEnvironmentId: string,
): string =>
	entries.find((entry) => entry.connectionKind === "local")?.environmentId ??
	activeEnvironmentId;

export const computerAwakeStatusText = (
	status: ComputerAwakeStatus | null,
): string => {
	if (status === null) return "Checking macOS power state…";
	const agentCount = `${status.activeAgents} local ${status.activeAgents === 1 ? "agent" : "agents"} running`;
	if (status.warning !== null) return `${agentCount} · ${status.warning}`;
	if (status.mode === "off")
		return `${agentCount} · Inactive — normal macOS sleep behavior.`;
	if (status.active) {
		if (status.mode === "always")
			return `${agentCount} · Active — Always mode.`;
		if (status.remoteClients > 0) {
			return `${agentCount} · Active — ${status.remoteClients} remote ${status.remoteClients === 1 ? "client" : "clients"} connected.`;
		}
		return `${agentCount} · Active — agent work in progress.`;
	}
	return `${agentCount} · Inactive — Auto starts for agents and remote clients.`;
};
