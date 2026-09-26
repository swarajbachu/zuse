import type { ExtensionAgentSession } from "@zuse/extension-sdk";
export const columns = [
	{ id: "error", title: "Needs attention" },
	{ id: "booting", title: "Starting" },
	{ id: "running", title: "Running" },
	{ id: "idle", title: "Idle" },
	{ id: "closed", title: "Closed" },
] as const;
export function filterSessions(
	sessions: readonly ExtensionAgentSession[],
	query: string,
	project: string,
	provider: string,
) {
	const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
	return sessions
		.filter(
			(s) =>
				(!project || s.projectId === project) &&
				(!provider || s.providerId === provider) &&
				terms.every((t) =>
					`${s.title} ${s.projectName} ${s.providerId} ${s.model}`
						.toLowerCase()
						.includes(t),
				),
		)
		.sort(
			(a, b) =>
				b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
		);
}
