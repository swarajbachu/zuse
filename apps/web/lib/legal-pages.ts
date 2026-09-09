export const LEGAL_PAGES = [
	{ label: "Privacy Policy", path: "/privacy", group: "Legal" },
	{ label: "Terms of Service", path: "/terms", group: "Legal" },
	{ label: "Cookie Policy", path: "/cookies", group: "Legal" },
	{ label: "Acceptable Use", path: "/acceptable-use", group: "Legal" },
	{ label: "Security", path: "/security", group: "Trust" },
	{ label: "Data Rights", path: "/data-rights", group: "Trust" },
	{ label: "Subprocessors", path: "/subprocessors", group: "Trust" },
	{ label: "Accessibility", path: "/accessibility", group: "Trust" },
] as const;

export const LEGAL_PAGE_PATHS = new Set<string>(
	LEGAL_PAGES.map((page) => page.path),
);

export const legalPageLinks = (group: "Legal" | "Trust") =>
	LEGAL_PAGES.filter((page) => page.group === group).map(({ label, path }) => ({
		label,
		href: path,
	}));
