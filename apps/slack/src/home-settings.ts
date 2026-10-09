import type { HomeSetting, MemberProfile } from "./installations.ts";

export interface HomeSelection {
	readonly connectionId: string;
	readonly actionTs: string;
}

/** Merge independent Home edits, without replaying older edits or crossing reconnects. */
export const homeSelectionDefaults = (
	profile: MemberProfile,
	field: HomeSetting,
	revision: number | undefined,
	selection?: HomeSelection,
): MemberProfile["defaults"] | null => {
	if (!selection)
		return revision === undefined || profile.revision === revision
			? profile.defaults
			: null;
	if (
		profile.connection?.webhookId !== selection.connectionId ||
		!/^\d{1,10}\.\d{1,6}$/u.test(selection.actionTs)
	)
		return null;
	// Only merge across other Home edits. Picker/default writes still invalidate old views.
	const base =
		profile.defaults.homeRevision?.current === profile.revision
			? profile.defaults.homeRevision.base
			: profile.revision;
	if (revision === undefined || revision < base || revision > profile.revision)
		return null;
	const previous = profile.defaults.homeActionTs?.[field];
	if (previous && Number(previous) >= Number(selection.actionTs)) return null;
	return {
		...profile.defaults,
		homeRevision: { base, current: profile.revision + 1 },
		homeActionTs: {
			...profile.defaults.homeActionTs,
			[field]: selection.actionTs,
		},
	};
};
