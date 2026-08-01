import type { ProviderId } from "@zuse/contracts";

/** Provider-managed refreshes must not recursively invalidate discovery. */
export const shouldRefreshSkillsForWatch = (
	providerId: ProviderId,
	filename: string | Buffer | null,
): boolean => {
	if (providerId !== "codex" || filename === null) return true;
	const normalized = filename.toString().replaceAll("\\", "/");
	return normalized !== ".system" && !normalized.startsWith(".system/");
};
