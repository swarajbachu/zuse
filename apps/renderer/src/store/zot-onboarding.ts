import { createAtomStore } from "../state/atom-store.ts";

export const ZOT_ONBOARDING_STEPS = [
	"welcome",
	"repositories",
	"brief",
	"slaves",
	"continuity",
] as const;
export type ZotOnboardingStep = (typeof ZOT_ONBOARDING_STEPS)[number];
type GuideStatus = "new" | "in-progress" | "dismissed" | "completed";
type GuideProgress = { step: ZotOnboardingStep; status: GuideStatus };
type GuideStorage = Pick<Storage, "getItem" | "setItem">;

const STORAGE_KEY = "zuse.zots.onboarding.v1";
const INITIAL_PROGRESS: GuideProgress = { step: "welcome", status: "new" };

const browserStorage = (): GuideStorage | null =>
	typeof window === "undefined" ? null : window.localStorage;

const isStep = (value: unknown): value is ZotOnboardingStep =>
	ZOT_ONBOARDING_STEPS.some((step) => step === value);

const readProgress = (storage: () => GuideStorage | null): GuideProgress => {
	try {
		const raw = storage()?.getItem(STORAGE_KEY);
		if (!raw) return INITIAL_PROGRESS;
		const value: unknown = JSON.parse(raw);
		if (
			typeof value === "object" &&
			value !== null &&
			"version" in value &&
			value.version === 1 &&
			"step" in value &&
			isStep(value.step) &&
			"status" in value &&
			(value.status === "in-progress" ||
				value.status === "dismissed" ||
				value.status === "completed")
		)
			return { step: value.step, status: value.status };
	} catch {
		// This preference must never prevent a Zot from opening.
	}
	return INITIAL_PROGRESS;
};

/** Device-local learning progress; never changes coordinator or worker state. */
export const createZotOnboardingStore = (
	storage: () => GuideStorage | null = browserStorage,
) => {
	const initial = readProgress(storage);
	return createAtomStore<
		GuideProgress & {
			open: boolean;
			start: () => void;
			next: () => void;
			back: () => void;
			dismiss: () => void;
			goTo: (step: ZotOnboardingStep) => void;
		}
	>((set, get) => {
		const update = (progress: GuideProgress) => {
			set({
				...progress,
				open: progress.status === "in-progress" || progress.status === "new",
			});
			try {
				storage()?.setItem(
					STORAGE_KEY,
					JSON.stringify({ version: 1, ...progress }),
				);
			} catch {
				// Still allow navigation when browser storage is unavailable or full.
			}
		};
		return {
			...initial,
			open: initial.status === "new" || initial.status === "in-progress",
			start: () => update({ step: "welcome", status: "in-progress" }),
			dismiss: () => update({ step: get().step, status: "dismissed" }),
			goTo: (step) => {
				if (get().open) update({ step, status: "in-progress" });
			},
			next: () => {
				if (!get().open) return;
				const index = ZOT_ONBOARDING_STEPS.indexOf(get().step);
				const next = ZOT_ONBOARDING_STEPS[index + 1];
				update({
					step: next ?? get().step,
					status: next ? "in-progress" : "completed",
				});
			},
			back: () => {
				if (!get().open) return;
				const index = ZOT_ONBOARDING_STEPS.indexOf(get().step);
				update({
					step: ZOT_ONBOARDING_STEPS[Math.max(0, index - 1)] ?? "welcome",
					status: "in-progress",
				});
			},
		};
	});
};

export const useZotOnboardingStore = createZotOnboardingStore();
