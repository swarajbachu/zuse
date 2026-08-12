export interface SubagentReference {
	readonly agentName: string;
}

export function subagentDisplayName(input: unknown): string {
	if (input === null || typeof input !== "object") return "agent";
	const record = input as Record<string, unknown>;
	const description =
		typeof record.description === "string" &&
		record.description.trim().length > 0 &&
		record.description !== "Task"
			? record.description.trim()
			: undefined;
	const subagentType =
		typeof record.subagent_type === "string" &&
		record.subagent_type.trim().length > 0
			? record.subagent_type.trim()
			: undefined;
	return description ?? subagentType ?? "agent";
}
