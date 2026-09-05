export const PROJECT_ICON_COLOR_IDS = [
	"rose",
	"orange",
	"amber",
	"emerald",
	"teal",
	"sky",
	"indigo",
	"violet",
	"pink",
] as const;

export type ProjectIconColorId = (typeof PROJECT_ICON_COLOR_IDS)[number];

export const isProjectIconColorId = (
	value: unknown,
): value is ProjectIconColorId =>
	typeof value === "string" &&
	(PROJECT_ICON_COLOR_IDS as ReadonlyArray<string>).includes(value);

export const PROJECT_ICON_COLOR_STYLES: Record<
	ProjectIconColorId,
	{ readonly swatch: string; readonly icon: string }
> = {
	rose: { swatch: "bg-rose-400", icon: "text-rose-500" },
	orange: { swatch: "bg-orange-400", icon: "text-orange-500" },
	amber: { swatch: "bg-amber-400", icon: "text-amber-500" },
	emerald: { swatch: "bg-emerald-400", icon: "text-emerald-500" },
	teal: { swatch: "bg-teal-400", icon: "text-teal-500" },
	sky: { swatch: "bg-sky-400", icon: "text-sky-500" },
	indigo: { swatch: "bg-indigo-400", icon: "text-indigo-500" },
	violet: { swatch: "bg-violet-400", icon: "text-violet-500" },
	pink: { swatch: "bg-pink-400", icon: "text-pink-500" },
};
